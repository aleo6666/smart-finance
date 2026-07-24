import { Router } from 'express'
import multer from 'multer'
import db from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    cb(null, allowed.includes(file.mimetype))
  }
})

function classifyFeedback(type, content) {
  const text = String(content || '').toLowerCase()
  if (/bug|错误|报错|崩溃|失败|异常/.test(text)) return { type: 'bug', priority: 'P0' }
  if (/建议|希望|增加|添加/.test(text)) return { type: 'suggestion', priority: 'P1' }
  if (/难用|不方便|卡|慢|体验|界面/.test(text)) return { type: 'ux', priority: 'P1' }
  return { type: type || 'suggestion', priority: 'P2' }
}

router.post('/', upload.single('screenshot'), async (req, res) => {
  const { deviceId } = req
  const { type = 'suggestion', content } = req.body
  if (!content?.trim()) return res.status(400).json({ success: false, error: '反馈内容不能为空' })

  const classified = classifyFeedback(type, content)
  const [id] = await db('feedback').insert({
    device_id: deviceId,
    type: classified.type,
    content: content.trim(),
    image_path: req.file?.path || null,
    priority: classified.priority
  })
  const feedback = await db('feedback').where({ id }).first()
  res.json({ success: true, data: feedback, message: `感谢你的反馈！反馈编号: #${feedback.id}` })
})

router.get('/', async (req, res) => {
  const query = db('feedback').where({ device_id: req.deviceId }).orderBy('created_at', 'desc').limit(50)
  if (req.query.status) query.where('status', req.query.status)
  res.json({ success: true, data: await query })
})

router.get('/status/:id', async (req, res) => {
  const fb = await db('feedback')
    .select('id', 'type', 'content', 'priority', 'status', 'admin_reply', 'created_at', 'updated_at')
    .where({ id: req.params.id, device_id: req.deviceId })
    .first()
  if (!fb) return res.status(404).json({ success: false, error: '反馈不存在' })
  res.json({ success: true, data: fb })
})

router.get('/survey', async (_req, res) => {
  res.json({ success: true, data: { showSurvey: false } })
})

router.post('/survey', async (req, res) => {
  const { rating, comment } = req.body
  await db('feedback').insert({
    device_id: req.deviceId,
    type: 'survey',
    content: `评分: ${rating}/5 | ${comment || '无附加意见'}`,
    priority: 'P1',
    status: 'pending'
  })
  res.json({ success: true, message: '感谢你的评价！' })
})

router.get('/admin/all', authMiddleware, async (req, res) => {
  const query = db('feedback')
  if (req.query.priority) query.where('priority', req.query.priority)
  if (req.query.type) query.where('type', req.query.type)
  if (req.query.status) query.where('status', req.query.status)
  const rows = await query.orderByRaw("CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END").orderBy('created_at', 'desc').limit(100)
  res.json({ success: true, data: rows })
})

router.put('/admin/:id', authMiddleware, async (req, res) => {
  const updates = {}
  for (const key of ['status', 'admin_reply', 'priority']) {
    if (req.body[key]) updates[key] = req.body[key]
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: '无更新字段' })
  updates.updated_at = db.fn.now()
  await db('feedback').where({ id: req.params.id }).update(updates)
  res.json({ success: true, data: await db('feedback').where({ id: req.params.id }).first() })
})

export default router
