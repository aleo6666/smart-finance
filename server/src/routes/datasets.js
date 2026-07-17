import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import {
  buildBadCaseDataset as defaultBuildBadCaseDataset,
  toJsonl
} from '../services/badCaseCollector.js'

export function createDatasetsRouter({
  buildBadCaseDataset = defaultBuildBadCaseDataset
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/bad-cases', async (req, res) => {
    const data = await buildBadCaseDataset({
      userId: req.userId,
      month: req.query.month,
      source: req.query.source
    })

    if (req.query.format === 'json') {
      return res.json({ success: true, data })
    }

    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8')
    res.send(toJsonl(data))
  })

  return router
}

export default createDatasetsRouter()
