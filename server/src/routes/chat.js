import { Router } from 'express'
import jwt from 'jsonwebtoken'
import config from '../config.js'
import { processMessage as defaultProcessMessage } from '../services/nlu.js'
import { createRecordTaskFromNlu as defaultCreateRecordTaskFromNlu } from '../services/plannerAgent.js'
import { recordFromPlannerTask as defaultRecordFromPlannerTask } from '../services/recorderAgent.js'
import { enqueueTask as defaultEnqueueTask, markTaskStatus as defaultMarkTaskStatus } from '../services/agentQueue.js'
import {
  appendConversationMessage as defaultAppendConversationMessage,
  getConversationContext as defaultGetConversationContext
} from '../services/conversationContext.js'
import {
  buildMemoryReply,
  extractQueryHints
} from '../services/chatMemory.js'
import { retrieveSimilar as defaultRetrieveSimilar } from '../services/vectorMemory.js'
import defaultRagService from '../services/ragService.js'
import {
  buildFinanceQueryReply,
  queryFinanceSummary as defaultQueryFinanceSummary
} from '../services/financeQuery.js'
import {
  planMultiStepTask as defaultPlanMultiStep,
  executePlan as defaultExecutePlan,
  detectCompoundIntent
} from '../services/orchestratorAgent.js'
import { recordAgentEvent as defaultRecordAgentEvent } from '../services/observeService.js'
import { submitAdviceForReview as defaultSubmitAdviceForReview } from '../services/adviceReview.js'
import { processQuery as defaultMasterProcessQuery } from '../services/masterAgent.js'
import { createAgentService, inRollout } from '../agent/service.js'

function defaultGetUserId(req) {
  try {
    const h = req.headers.authorization
    if (h && h.startsWith('Bearer ')) {
      return jwt.verify(h.slice(7), config.auth.jwtSecret).userId
    }
  } catch {}
  return null
}

export function createChatRouter({
  getUserId = defaultGetUserId,
  processMessage = defaultProcessMessage,
  createRecordTaskFromNlu = defaultCreateRecordTaskFromNlu,
  recordFromPlannerTask = defaultRecordFromPlannerTask,
  enqueueTask = defaultEnqueueTask,
  markTaskStatus = defaultMarkTaskStatus,
  getConversationContext = defaultGetConversationContext,
  appendConversationMessage = defaultAppendConversationMessage,
  retrieveSimilar = defaultRetrieveSimilar,
  queryFinanceSummary = defaultQueryFinanceSummary,
  ragService = null,
  planMultiStep = defaultPlanMultiStep,
  executePlan = defaultExecutePlan,
  recordAgentEvent = defaultRecordAgentEvent,
  submitAdviceForReview = defaultSubmitAdviceForReview,
  masterProcessQuery = defaultMasterProcessQuery,
  agentService = null,
  buildRuntimeContext = null
} = {}) {
  const router = Router()

  function withTimeout(promise, timeoutMs = 300) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('memory operation timeout')), timeoutMs))
    ])
  }

  async function getContextSafely(identity) {
    return withTimeout(getConversationContext(identity)).catch(error => {
      console.warn('[Chat] context read skipped:', error.message)
      return []
    })
  }

  async function retrieveSimilarSafely(message, options) {
    return withTimeout(retrieveSimilar(message, options)).catch(error => {
      console.warn('[Chat] memory retrieval skipped:', error.message)
      return []
    })
  }

  async function queryFinanceSafely(userId, hints) {
    return withTimeout(queryFinanceSummary({ userId, hints }), 500).catch(error => {
      console.warn('[Chat] finance query skipped:', error.message)
      return null
    })
  }

  async function appendTurn(identity, userMessage, assistantMessage) {
    await withTimeout((async () => {
      await appendConversationMessage(identity, { role: 'user', content: userMessage })
      await appendConversationMessage(identity, { role: 'assistant', content: assistantMessage })
    })())
  }

  router.post('/', async (req, res) => {
    const { deviceId } = req
    const { message } = req.body
    const userId = getUserId(req)

    if (!message) {
      return res.status(400).json({ success: false, error: '消息不能为空' })
    }

    try {
      const identity = userId ? `user-${userId}` : deviceId

      // ---- LangGraph Agent 接入（灰度兼容）----
      if (agentService && buildRuntimeContext && userId) {
        const runtime = buildRuntimeContext({ req, userId, isAdmin: false })
        const state = { messages: [{ role: 'user', content: message }] }
        const output = await agentService.handle(state, runtime)
        if (output.data?.source && output.data.source !== 'legacy') {
          await appendTurn(identity, message, output.data?.message || '').catch(error => {
            console.warn('[Chat] LangGraph context append skipped:', error.message)
          })
          return res.json(output)
        }
      }

      // ---- 极简 3 Agent 架构（主从协同）----
      // 通过 use3Agent 参数启用新架构，用于灰度验证
      const use3Agent = req.body.use3Agent === true || req.query.use3Agent === 'true'
      if (use3Agent && userId) {
        const started = Date.now()
        const masterResult = await masterProcessQuery({ userId, message })

        // 记录到观测系统
        recordAgentEvent({
          userId,
          callType: 'master_agent',
          latencyMs: Date.now() - started,
          success: masterResult.success
        }).catch(() => {})

        // 保存对话上下文
        await appendTurn(identity, message, masterResult.answer || '').catch(error => {
          console.warn('[Chat] 3Agent context append skipped:', error.message)
        })

        return res.json({
          success: masterResult.success,
          data: {
            intent: 'query',
            message: masterResult.answer,
            agent: '3agent',
            pattern: masterResult.pattern,
            execution: masterResult.execution,
            error: masterResult.error
          }
        })
      }

      const result = await processMessage(identity, message)

      // ---- 编排链路：复合意图走多步编排 ----
      // 放宽：query/advice/chat 都允许，只要 compoundIntent 命中且已登录
      const compoundIntent = detectCompoundIntent(message)
      const orchestratedIntents = ['query', 'advice', 'chat']
      let orchestrationRan = false
      const shouldAttemptOrchestration = compoundIntent && orchestratedIntents.includes(result.intent) && userId

      if (shouldAttemptOrchestration) {
        const started = Date.now()
        try {
          const hints = extractQueryHints(message, { context: await getContextSafely(identity).catch(() => []) })
          const plan = await planMultiStep({ message, userId, hints })
          const execResult = await executePlan({
            plan,
            userId,
            recordStepFn: ({ userId: uid, stepIntent, latencyMs, success, errorMessage }) =>
              recordAgentEvent({ userId: uid, callType: `orchestrator_${stepIntent}`, latencyMs, success, errorMessage }).catch(() => {})
          })

          // 审核（中高风险不影响报告输出，只追加提示）
          let reviewResult = null
          if (execResult.advice) {
            try {
              reviewResult = await submitAdviceForReview({
                userId,
                adviceText: execResult.advice,
                context: { planId: execResult.planId, compoundIntent, message }
              })
            } catch (e) {
              console.warn('[Chat] advice review skipped:', e.message)
            }
          }

          // 消息优先级：编排报告 > 编排摘要 > NLU 原消息
          const primaryMsg = execResult.report || execResult.summary || result.message
          // 审核提示作为脚注追加，不覆盖报告正文
          const reviewNote = reviewResult?.needsReview
            ? `\n\n---\n${reviewResult.disclaimer}\n⚠️ 该建议已提交人工审核，通过后将通知您。`
            : ''
          result.message = primaryMsg + reviewNote

          result.orchestrator = {
            planId: execResult.planId,
            intent: compoundIntent,
            steps: execResult.steps?.map(s => ({ intent: s.intent, success: s.success, latencyMs: s.latencyMs })),
            succeededCount: execResult.succeededCount,
            failedCount: execResult.failedCount
          }
          if (reviewResult) {
            result.review = { id: reviewResult.id, riskLevel: reviewResult.riskLevel, needsReview: reviewResult.needsReview }
          }

          orchestrationRan = true

          recordAgentEvent({
            userId,
            callType: 'orchestrator',
            latencyMs: Date.now() - started,
            success: execResult.success
          }).catch(() => {})
        } catch (error) {
          console.warn('[Chat] orchestrator skipped:', error.message)
          result.orchestrator = { error: error.message }
        }
      }

      // ---- 常规记忆/RAG：编排已处理则跳过 ----
      const shouldUseMemory = ['query', 'advice', 'chat'].includes(result.intent) && !orchestrationRan
      if (shouldUseMemory) {
        const context = await getContextSafely(identity)
        const hints = extractQueryHints(message, { context })
        const financeSummary = userId && result.intent === 'query'
          ? await queryFinanceSafely(userId, hints)
          : null
        const records = userId
          ? await retrieveSimilarSafely(message, { userId, ...hints, limit: config.rag.topK })
          : []
        if (financeSummary) {
          result.message = buildFinanceQueryReply(financeSummary)
          result.finance = {
            count: financeSummary.count,
            total: financeSummary.total,
            average: financeSummary.average,
            hints: financeSummary.hints
          }
        } else {
          let ragUsed = false
          if (userId && (result.intent === 'advice' || result.intent === 'query') && ragService) {
            try {
              const ragResult = await ragService.answer({
                question: message,
                userId,
                hints,
                baseMessage: result.message
              })
              result.message = ragResult.message
              result.rag = { records: ragResult.records, sources: ragResult.sources }
              ragUsed = true
            } catch (error) {
              console.warn('[Chat] RAG answer skipped:', error.message)
            }
          }
          if (!ragUsed) {
            result.message = buildMemoryReply({
              intent: result.intent,
              baseMessage: result.message,
              records
            })
          }
        }
        result.memory = {
          records: records.length,
          hints
        }
      }

      // ---- 建议审核：非编排路径的 advice 意图（编排已审核则跳过） ----
      if (result.intent === 'advice' && userId && result.message && !orchestrationRan) {
        try {
          const reviewResult = await submitAdviceForReview({
            userId,
            adviceText: result.message,
            context: { intent: 'advice', message }
          })
          // 低风险直接放行用原文；中高风险附带免责声明，不替换正文
          if (reviewResult.needsReview) {
            result.message = result.message + `\n\n---\n${reviewResult.disclaimer}\n⚠️ 该建议已提交人工审核，通过后将通知您。`
          }
          result.review = { id: reviewResult.id, riskLevel: reviewResult.riskLevel, needsReview: reviewResult.needsReview }
        } catch (e) {
          console.warn('[Chat] advice review skipped:', e.message)
        }
      }

      if (result.intent === 'record' && result.data?.amount) {
        if (!userId) {
          return res.json({ success: true, data: { intent: 'chat', message: '请先登录后再记账。', data: null } })
        }
        const task = createRecordTaskFromNlu({ userId, deviceId, message, nluResult: result })
        if (task) {
          await enqueueTask(task.agentType, task.payload, { taskId: task.taskId })
          await markTaskStatus(task.taskId, 'running')
          const recordResult = await recordFromPlannerTask({ task })
          await markTaskStatus(task.taskId, 'succeeded', { result: recordResult })
          result.recordIds = recordResult.recordIds
          result.agent = { taskId: task.taskId, status: 'succeeded' }
        }
      }

      await appendTurn(identity, message, result.message).catch(error => {
        console.warn('[Chat] context append skipped:', error.message)
      })

      res.json({ success: true, data: result })
    } catch (error) {
      console.error('Chat error:', error)
      res.status(500).json({
        success: false,
        error: '抱歉，处理消息时出了一点问题，请稍后再试。'
      })
    }
  })

  return router
}

export default createChatRouter({ ragService: defaultRagService })
