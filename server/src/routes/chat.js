import { Router } from 'express'
import jwt from 'jsonwebtoken'
import config from '../config.js'
import { processMessage as defaultProcessMessage } from '../services/nlu.js'
import { createRecordTaskFromNlu as defaultCreateRecordTaskFromNlu } from '../services/plannerAgent.js'
import { recordFromPlannerTask as defaultRecordFromPlannerTask } from '../services/recorderAgent.js'
import { enqueueTask as defaultEnqueueTask, markTaskStatus as defaultMarkTaskStatus } from '../services/agentQueue.js'

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
  markTaskStatus = defaultMarkTaskStatus
} = {}) {
  const router = Router()

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
