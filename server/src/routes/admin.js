import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { requireRole } from '../middleware/rbac.js'
import { getMetrics } from '../middleware/observability.js'

const router = Router()
router.use(authMiddleware)

/** GET /api/admin/metrics — Agent 可观测数据 */
router.get('/metrics', requireRole('owner', 'admin'), (req, res) => {
  try {
    const data = getMetrics()
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, error: '获取指标失败' })
  }
})

/** GET /api/admin/health — 系统健康检查 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      uptime: getMetrics().uptime_seconds,
      agents: getMetrics().agent.calls,
    }
  })
})

export default router
