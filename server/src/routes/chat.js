import { Router } from 'express'
import db from '../db.js'
import { processMessage } from '../services/nlu.js'
import { updateHabitMemory, updateMemory } from '../services/memory.js'

const router = Router()

router.post('/', async (req, res) => {
  const { deviceId } = req
  const { message } = req.body

  if (!message) {
    return res.status(400).json({ success: false, error: '消息不能为空' })
  }

  try {
    const result = await processMessage(deviceId, message)

    // 根据意图执行对应操作
    if (result.intent === 'record' && result.data && result.data.amount) {
      const { type = 'expense', amount, category = '其他', description = '', date } = result.data
      const recordDate = date || new Date().toISOString().slice(0, 10)

      db.prepare(
        'INSERT INTO records (device_id, type, amount, category, description, date) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(deviceId, type, amount, category, description, recordDate)

      // 更新消费习惯记忆
      if (type === 'expense') {
        updateHabitMemory(deviceId, category, amount)
      }

      // 更新偏好设置
      if (result.data.preferences) {
        updateMemory(deviceId, 'preferences', result.data.preferences)
      }
    }

    if (result.intent === 'goal' && result.data) {
      const { name, target_amount, deadline } = result.data
      if (name && target_amount) {
        db.prepare(
          'INSERT INTO goals (device_id, name, target_amount, deadline) VALUES (?, ?, ?, ?)'
        ).run(deviceId, name, target_amount, deadline || null)
      }
    }

    res.json({ success: true, data: result })
  } catch (error) {
    console.error('Chat error:', error)
    res.json({
      success: true,
      data: {
        intent: 'chat',
        message: '抱歉，处理消息时出了点问题，请稍后再试 😅',
        data: null
      }
    })
  }
})

export default router
