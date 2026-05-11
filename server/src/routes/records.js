import { Router } from 'express'
import db from '../db.js'

const router = Router()

// 查询记录
router.get('/', (req, res) => {
  const { month, category, type, page = 1, limit = 50 } = req.query
  const { deviceId } = req

  let sql = 'SELECT * FROM records WHERE device_id = ?'
  const params = [deviceId]

  if (month) {
    sql += ' AND strftime("%Y-%m", date) = ?'
    params.push(month)
  }
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }
  if (type) {
    sql += ' AND type = ?'
    params.push(type)
  }

  const offset = (Number(page) - 1) * Number(limit)
  sql += ' ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?'
  params.push(Number(limit), offset)

  const records = db.prepare(sql).all(...params)
  res.json({ success: true, data: records })
})

// 创建记录
router.post('/', (req, res) => {
  const { deviceId } = req
  const { type = 'expense', amount, category, description, date } = req.body

  if (!amount || !category || !date) {
    return res.status(400).json({ success: false, error: '缺少必填字段: amount, category, date' })
  }

  const result = db.prepare(
    'INSERT INTO records (device_id, type, amount, category, description, date) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(deviceId, type, amount, category, description || '', date)

  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(result.lastInsertRowid)
  res.json({ success: true, data: record })
})

// 删除记录
router.delete('/:id', (req, res) => {
  const { deviceId } = req
  const { id } = req.params

  const record = db.prepare('SELECT * FROM records WHERE id = ? AND device_id = ?').get(id, deviceId)
  if (!record) {
    return res.status(404).json({ success: false, error: '记录不存在' })
  }

  db.prepare('DELETE FROM records WHERE id = ? AND device_id = ?').run(id, deviceId)
  res.json({ success: true, message: '已删除' })
})

export default router
