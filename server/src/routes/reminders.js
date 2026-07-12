import { Router } from 'express'
import db from '../db.js'

const router = Router()

// 获取用户的未读提醒
router.get('/', (req, res) => {
  const { deviceId } = req
  const reminders = db.prepare(
    `SELECT * FROM reminders WHERE device_id = ? AND status = 'pending'
     ORDER BY created_at DESC LIMIT 20`
  ).all(deviceId)
  res.json({ success: true, data: reminders })
})

// 获取未读数量（用于红点显示）
router.get('/count', (req, res) => {
  const { deviceId } = req
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM reminders
     WHERE device_id = ? AND status = 'pending'`
  ).get(deviceId)
  res.json({ success: true, data: row.count })
})

// 标记提醒为已读
router.put('/:id/read', (req, res) => {
  const { deviceId } = req
  const { id } = req.params
  db.prepare(
    `UPDATE reminders SET status = 'read', read_at = datetime('now','localtime')
     WHERE id = ? AND device_id = ?`
  ).run(id, deviceId)
  res.json({ success: true, message: '已标记为已读' })
})

// 一键全部已读
router.put('/read-all', (req, res) => {
  const { deviceId } = req
  db.prepare(
    `UPDATE reminders SET status = 'read', read_at = datetime('now','localtime')
     WHERE device_id = ? AND status = 'pending'`
  ).run(deviceId)
  res.json({ success: true, message: '全部已标记为已读' })
})

export default router
