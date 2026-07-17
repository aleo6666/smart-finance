import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { getObserveStats as defaultGetObserveStats } from '../services/observeService.js'

export function createObserveRouter({
  getObserveStats = defaultGetObserveStats
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/stats', async (req, res) => {
    const data = await getObserveStats({
      userId: req.userId,
      period: req.query.period
    })
    res.json({ success: true, data })
  })

  return router
}

export default createObserveRouter()
