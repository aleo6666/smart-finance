import { Router } from 'express'
import db from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

function priorityForAccuracy(isAccurate) {
  return isAccurate ? 'P2' : 'P1'
}

export function createInsightsRouter({ dbClient = db } = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.post('/feedback', async (req, res) => {
    const { insightId, reportId = null, isAccurate, correction = '', context = {} } = req.body || {}
    if (!insightId) return res.status(400).json({ success: false, error: '缺少 insightId' })
    if (typeof isAccurate !== 'boolean') return res.status(400).json({ success: false, error: 'isAccurate 必须是 boolean' })

    const priority = priorityForAccuracy(isAccurate)
    const content = JSON.stringify({ insightId, reportId, isAccurate, correction, context })
    const [id] = await dbClient('feedback').insert({
      device_id: req.deviceId || null,
      user_id: req.userId,
      type: 'ai_insight',
      content,
      priority,
      status: 'pending'
    })

    res.json({ success: true, data: { id, priority } })
  })

  return router
}

export default createInsightsRouter()
