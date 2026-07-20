import { Router } from 'express'
import { checkDependencies, createDefaultChecks } from '../services/healthService.js'

export function createHealthRouter({ checkDeps = checkDependencies, createChecks = createDefaultChecks } = {}) {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({ success: true, message: '智能财务记账助手服务运行中' })
  })

  router.get('/ready', async (_req, res) => {
    const checks = createChecks()
    const result = await checkDeps({ checks })
    const status = result.status === 'ready' ? 200 : 503
    res.status(status).json(result)
  })

  return router
}
