import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { getObserveStats } from '../services/observeService.js'

const router = Router()
router.use(authMiddleware)

router.get('/stats', async (req, res) => {
  const data = await getObserveStats({ userId: req.query.userId ? Number(req.query.userId) : req.userId })
  res.json({ success: true, data })
})

export default router
