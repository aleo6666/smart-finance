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
import { submitAdviceForReview as defaultSubmitAdviceForReview } from '../services/adviceReview.js'

// Lazily set during agent bootstrap — avoids import-time dependency on agent modules
let _agentService = null
let _buildRuntimeContext = null
export function injectAgentDeps({ agentService, buildRuntimeContext }) {
  _agentService = agentService ?? null
  _buildRuntimeContext = buildRuntimeContext ?? null
}

function defaultGetUserId(req) {
  try {
    const h = req.headers.authorization
    if (h && h.startsWith('Bearer ')) {
      return jwt.verify(h.slice(7), config.auth.jwtSecret).userId
    }
  } catch {}
  return null
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function datePartsInTimezone(date, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  }
}

function ymdFromParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

function monthFromParts(parts) {
  return `${parts.year}-${pad2(parts.month)}`
}

function previousMonth(parts) {
  return parts.month === 1
    ? { year: parts.year - 1, month: 12, day: 1 }
    : { year: parts.year, month: parts.month - 1, day: 1 }
}

function normalizeLedgerId(value) {
  const ledgerId = Number(value)
  return Number.isSafeInteger(ledgerId) && ledgerId > 0 ? ledgerId : null
}

function extractKnownCategory(text) {
  const categories = [
    '餐饮',
    '交通',
    '购物',
    '住房',
    '医疗',
    '教育',
    '娱乐',
    '旅行',
    '通讯',
    '日用',
    '其他'
  ]
  return categories.find(category => text.includes(category)) || null
}

function detectDeterministicFinanceIntent(message, {
  now = new Date(),
  timezone = 'Asia/Shanghai',
  ledgerId = null
} = {}) {
  const text = String(message || '').trim()
  const parts = datePartsInTimezone(now, timezone)
  const scopedLedgerId = normalizeLedgerId(ledgerId)
  const category = extractKnownCategory(text)
  const baseHints = {
    type: 'expense',
    ...(category ? { category } : {}),
    ...(scopedLedgerId ? { ledgerId: scopedLedgerId } : {}),
    queryKind: 'summary'
  }

  if (/(下个月|下月)/.test(text) && /(建议|规划|预算|怎么花|怎么控制|省钱)/.test(text)) {
    return {
      intent: 'suggest',
      label: '下个月建议',
      hints: {
        month: monthFromParts(parts),
        ...baseHints
      }
    }
  }

  if (!/(花了多少|花多少|消费|支出|开销|用了多少)/.test(text)) return null

  if (/(今天|今日)/.test(text)) {
    const today = ymdFromParts(parts)
    return {
      intent: 'query',
      label: '今天',
      hints: {
        startDate: today,
        endDate: today,
        ...baseHints
      }
    }
  }

  if (/(上个月|上月)/.test(text)) {
    return {
      intent: 'query',
      label: '上月',
      hints: {
        month: monthFromParts(previousMonth(parts)),
        ...baseHints
      }
    }
  }

  if (/(这个月|本月|这月|当月)/.test(text)) {
    return {
      intent: 'query',
      label: '本月',
      hints: {
        month: monthFromParts(parts),
        ...baseHints
      }
    }
  }

  return null
}

function formatRecordDate(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function buildDeterministicFinanceReply(intent, summary) {
  if (intent.intent === 'suggest') {
    if (!summary?.count) {
      return '下个月建议：当前还没有本月支出记录。先保持日常记账，月底再按真实分类做预算会更准。'
    }
    const dailyAverage = summary.total / 30
    const target = summary.total * 0.9
    return [
      `下个月建议：本月已支出 ${summary.total.toFixed(2)} 元，共 ${summary.count} 笔，平均每笔 ${summary.average.toFixed(2)} 元。`,
      `建议下月预算先按 ${target.toFixed(2)} 元控制，日均约 ${dailyAverage.toFixed(2)} 元。`,
      summary.maxRecord
        ? `优先关注最大单笔 ${Number(summary.maxRecord.amount).toFixed(2)} 元${summary.maxRecord.category ? `（${summary.maxRecord.category}）` : ''}，这类支出最容易拉高总额。`
        : '优先关注高频小额支出，月底通常就是它们悄悄堆高总额。'
    ].join('\n')
  }

  if (!summary?.count) return `${intent.label}暂无支出记录。`
  const maxText = summary.maxRecord
    ? `\n最大单笔：${Number(summary.maxRecord.amount).toFixed(2)} 元（${formatRecordDate(summary.maxRecord.date)}${summary.maxRecord.description ? `，${summary.maxRecord.description}` : ''}）`
    : ''
  return `${intent.label}支出共 ${summary.total.toFixed(2)} 元，合计 ${summary.count} 笔，平均每笔 ${summary.average.toFixed(2)} 元。${maxText}`
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
  submitAdviceForReview = defaultSubmitAdviceForReview,
  now = () => new Date()
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
      const deterministicIntent = userId
        ? detectDeterministicFinanceIntent(message, {
            now: now(),
            timezone: req.headers['x-timezone'] || 'Asia/Shanghai',
            ledgerId: req.body.ledgerId
          })
        : null
      if (deterministicIntent) {
        const summary = await queryFinanceSafely(userId, deterministicIntent.hints)
        if (!summary) {
          // Fall through to the existing NLU/RAG path when exact SQL is unavailable.
        } else {
          const reply = buildDeterministicFinanceReply(deterministicIntent, summary)
          await appendTurn(identity, message, reply).catch(error => {
            console.warn('[Chat] deterministic finance context append skipped:', error.message)
          })
          return res.json({
            success: true,
            data: {
              intent: deterministicIntent.intent,
              message: reply,
              finance: summary,
              source: 'deterministic_finance'
            }
          })
        }
      }

      // ---- LangGraph Agent 接入（灰度兼容）----
      if (_agentService && _buildRuntimeContext && userId) {
        req.sessionId = req.body.sessionId || req.headers['x-session-id'] || req.deviceId
        const runtime = _buildRuntimeContext({ req, userId, isAdmin: false })
        const state = { messages: [{ role: 'user', content: message }] }
        const output = await _agentService.handle(state, runtime)
        if (output.data?.source && output.data.source !== 'legacy') {
          await appendTurn(identity, message, output.data?.message || '').catch(error => {
            console.warn('[Chat] LangGraph context append skipped:', error.message)
          })
          return res.json(output)
        }
      }

      const result = await processMessage(identity, message)

      // ---- 常规记忆/RAG ----
      const shouldUseMemory = ['query', 'advice', 'chat'].includes(result.intent)
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

      // ---- 建议审核：advice 意图 ----
      if (result.intent === 'advice' && userId && result.message) {
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
