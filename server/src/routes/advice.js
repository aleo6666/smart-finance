import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import {
  listPendingReviews as defaultListPending,
  getReviewById as defaultGetReview,
  approveReview as defaultApprove,
  rejectReview as defaultReject,
  modifyReview as defaultModify
} from '../services/adviceReview.js'

export function createAdviceRouter({
  listPending = defaultListPending,
  getReview = defaultGetReview,
  approve = defaultApprove,
  reject = defaultReject,
  modify = defaultModify
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  // 待审核列表
  router.get('/reviews', async (req, res) => {
    try {
      const { status = 'pending', offset = 0, limit = 50 } = req.query
      const data = await listPending({
        status,
        offset: Number(offset),
        limit: Number(limit)
      })
      res.json({ success: true, data })
    } catch (error) {
      console.error('[Advice] list failed:', error.message)
      res.status(500).json({ success: false, error: '获取审核列表失败' })
    }
  })

  // 单条详情
  router.get('/reviews/:id', async (req, res) => {
    try {
      const review = await getReview(req.params.id)
      res.json({ success: true, data: review })
    } catch (error) {
      const status = error.statusCode || 500
      res.status(status).json({ success: false, error: error.message || '获取审核详情失败' })
    }
  })

  // 批准
  router.post('/reviews/:id/approve', async (req, res) => {
    try {
      const result = await approve(req.params.id, { reviewedBy: req.userId })
      res.json({ success: true, data: result })
    } catch (error) {
      const status = error.statusCode || 500
      res.status(status).json({ success: false, error: error.message || '批准失败' })
    }
  })

  // 拒绝
  router.post('/reviews/:id/reject', async (req, res) => {
    try {
      const { reason = '' } = req.body || {}
      const result = await reject(req.params.id, { reviewedBy: req.userId, reason })
      res.json({ success: true, data: result })
    } catch (error) {
      const status = error.statusCode || 500
      res.status(status).json({ success: false, error: error.message || '拒绝失败' })
    }
  })

  // 修改
  router.post('/reviews/:id/modify', async (req, res) => {
    try {
      const { modifiedAdvice = '', reason = '' } = req.body || {}
      const result = await modify(req.params.id, {
        reviewedBy: req.userId,
        modifiedAdvice,
        reason
      })
      res.json({ success: true, data: result })
    } catch (error) {
      const status = error.statusCode || 400
      res.status(status).json({ success: false, error: error.message || '修改失败' })
    }
  })

  return router
}

export default createAdviceRouter()
