import { Router } from 'express'
import db from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

router.get('/', async (req, res) => {
  const reminders = await db('reminders')
    .where({ user_id: req.userId, status: 'pending' })
    .orderBy('created_at', 'desc')
    .limit(20)
  res.json({ success: true, data: reminders })
})

router.get('/count', async (req, res) => {
  const row = await db('reminders').where({ user_id: req.userId, status: 'pending' }).count({ count: '*' }).first()
  res.json({ success: true, data: Number(row?.count || 0) })
})

router.put('/read-all', async (req, res) => {
  await db('reminders').where({ user_id: req.userId, status: 'pending' }).update({ status: 'read', read_at: db.fn.now() })
  res.json({ success: true, message: '全部已标记为已读' })
})

router.put('/:id/read', async (req, res) => {
  await db('reminders').where({ id: req.params.id, user_id: req.userId }).update({ status: 'read', read_at: db.fn.now() })
  res.json({ success: true, message: '已标记为已读' })
})

router.post('/subscribe', async (req, res) => {
  const { templateId = process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID, openid } = req.body
  if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' })
  await db('wechat_subscribe')
    .insert({ user_id: req.userId, openid, template_id: templateId, status: 'authorized', authorized_at: db.fn.now() })
    .onConflict(['user_id', 'template_id'])
    .merge({ openid, status: 'authorized', authorized_at: db.fn.now() })
  res.json({ success: true })
})

export default router
