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
  retrieveSimilar = defaultRetrieveSimilar
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
      const result = await processMessage(identity, message)

      const shouldUseMemory = ['query', 'advice', 'chat'].includes(result.intent)
      if (shouldUseMemory) {
        await getContextSafely(identity)
        const hints = extractQueryHints(message)
        const records = userId
          ? await retrieveSimilar(message, { userId, ...hints, limit: 5 })
          : []
        result.message = buildMemoryReply({
          intent: result.intent,
          baseMessage: result.message,
          records
        })
        result.memory = {
          records: records.length,
          hints
        }
      }

      if (result.intent === 'record' && result.data?.amount) {
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
      res.json({
        success: true,
        data: {
          intent: 'chat',
          message: '抱歉，处理消息时出了一点问题，请稍后再试。',
          data: null
        }
      })
    }
  })

  return router
}

export default createChatRouter()
