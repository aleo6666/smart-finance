import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import db, { shouldSendSurvey, markSurveySent, trackDevice } from '../db.js'

const router = Router()

// multer for feedback screenshots
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    cb(null, allowed.includes(file.mimetype))
  }
})

// 提交反馈
router.post('/', upload.single('screenshot'), (req, res) => {
  const { deviceId } = req
  const { type = 'suggestion', content } = req.body

  if (!content || !content.trim()) {
    return res.status(400).json({ success: false, error: '反馈内容不能为空' })
  }

  // 自动分类和分级
  let category = type
  let priority = 'P2'
  const text = content.toLowerCase()
  if (/bug|错误|报错|崩溃|闪退|不行|不能|失败|异常/.test(text)) {
    category = 'bug'; priority = 'P0'
  } else if (/建议|希望|增加|添加|能不能|可以不可以/.test(text)) {
    category = 'suggestion'; priority = 'P1'
  } else if (/难用|不方便|卡|慢|体验|界面|字/.test(text)) {
    category = 'ux'; priority = 'P1'
  }

  const result = db.prepare(
    `INSERT INTO feedback (device_id, type, content, image_path, priority)
     VALUES (?, ?, ?, ?, ?)`
  ).run(deviceId, category, content.trim(), req.file?.path || null, priority)

  const feedback = db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid)

  res.json({
    success: true,
    data: feedback,
    message: '感谢你的反馈！我们会认真对待每一条建议 💪\n反馈编号: #' + feedback.id
  })
})

// 查询用户的历史反馈
router.get('/', (req, res) => {
  const { deviceId } = req
  const { status } = req.query

  let sql = 'SELECT * FROM feedback WHERE device_id = ?'
  const params = [deviceId]
  if (status) { sql += ' AND status = ?'; params.push(status) }

  sql += ' ORDER BY created_at DESC LIMIT 50'
  const list = db.prepare(sql).all(...params)
  res.json({ success: true, data: list })
})

// 反馈详情（按反馈编号查询，无需设备匹配）
router.get('/status/:id', (req, res) => {
  const { deviceId } = req
  const fb = db.prepare(
    'SELECT id, type, content, priority, status, admin_reply, created_at, updated_at FROM feedback WHERE id = ? AND device_id = ?'
  ).get(req.params.id, deviceId)

  if (!fb) return res.status(404).json({ success: false, error: '反馈不存在' })
  res.json({ success: true, data: fb })
})

// 7日满意度调研检查
router.get('/survey', (req, res) => {
  const { deviceId } = req
  trackDevice(deviceId)

  if (shouldSendSurvey(deviceId)) {
    res.json({
      success: true,
      data: { showSurvey: true, message: '你已经使用7天了！来评价一下吧 😊' }
    })
  } else {
    res.json({ success: true, data: { showSurvey: false } })
  }
})

// 提交调研结果
router.post('/survey', (req, res) => {
  const { deviceId } = req
  const { rating, comment } = req.body

  markSurveySent(deviceId)

  // 调研结果以特殊反馈类型存储
  db.prepare(
    `INSERT INTO feedback (device_id, type, content, priority, status)
     VALUES (?, 'survey', ?, 'P1', 'pending')`
  ).run(deviceId, `评分: ${rating}/5 | ${comment || '无附加意见'}`)

  res.json({ success: true, message: '感谢你的评价！我们会继续努力做得更好 ✨' })
})

// 管理员——获取所有反馈（简易后台）
router.get('/admin/all', (req, res) => {
  const { priority, type, status } = req.query
  let sql = 'SELECT * FROM feedback WHERE 1=1'
  const params = []
  if (priority) { sql += ' AND priority = ?'; params.push(priority) }
  if (type) { sql += ' AND type = ?'; params.push(type) }
  if (status) { sql += ' AND status = ?'; params.push(status) }
  sql += " ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, created_at DESC LIMIT 100"

  res.json({ success: true, data: db.prepare(sql).all(...params) })
})

// 管理员——更新反馈状态/回复
router.put('/admin/:id', (req, res) => {
  const { status, admin_reply, priority } = req.body
  const updates = []
  const params = []

  if (status) { updates.push('status = ?'); params.push(status) }
  if (admin_reply) { updates.push('admin_reply = ?'); params.push(admin_reply) }
  if (priority) { updates.push('priority = ?'); params.push(priority) }
  updates.push("updated_at = datetime('now','localtime')")

  if (updates.length === 0) return res.status(400).json({ success: false, error: '无更新字段' })

  params.push(req.params.id)
  db.prepare(`UPDATE feedback SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const fb = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id)
  res.json({ success: true, data: fb })
})

export default router
