import { Router } from 'express'
import db from '../db.js'

const router = Router()

// 获取所有目标
router.get('/', (req, res) => {
  const { deviceId } = req
  const goals = db.prepare(
    'SELECT * FROM goals WHERE device_id = ? ORDER BY created_at DESC'
  ).all(deviceId)
  res.json({ success: true, data: goals })
})

// 创建目标
router.post('/', (req, res) => {
  const { deviceId } = req
  const { name, target_amount, current_amount = 0, deadline } = req.body

  if (!name || !target_amount) {
    return res.status(400).json({ success: false, error: '缺少必填字段: name, target_amount' })
  }

  const result = db.prepare(
    'INSERT INTO goals (device_id, name, target_amount, current_amount, deadline) VALUES (?, ?, ?, ?, ?)'
  ).run(deviceId, name, target_amount, current_amount, deadline || null)

  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(result.lastInsertRowid)
  res.json({ success: true, data: goal })
})

// 更新目标进度
router.put('/:id', (req, res) => {
  const { deviceId } = req
  const { id } = req.params
  const { current_amount, name, target_amount, deadline, completed } = req.body

  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND device_id = ?').get(id, deviceId)
  if (!goal) {
    return res.status(404).json({ success: false, error: '目标不存在' })
  }

  const updates = []
  const params = []
  if (current_amount !== undefined) { updates.push('current_amount = ?'); params.push(current_amount) }
  if (name !== undefined) { updates.push('name = ?'); params.push(name) }
  if (target_amount !== undefined) { updates.push('target_amount = ?'); params.push(target_amount) }
  if (deadline !== undefined) { updates.push('deadline = ?'); params.push(deadline) }
  if (completed !== undefined) { updates.push('completed = ?'); params.push(completed) }

  if (updates.length > 0) {
    params.push(id, deviceId)
    db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id = ? AND device_id = ?`).run(...params)
  }

  const updated = db.prepare('SELECT * FROM goals WHERE id = ?').get(id)
  res.json({ success: true, data: updated })
})

// 删除目标
router.delete('/:id', (req, res) => {
  const { deviceId } = req
  const { id } = req.params

  const goal = db.prepare('SELECT * FROM goals WHERE id = ? AND device_id = ?').get(id, deviceId)
  if (!goal) {
    return res.status(404).json({ success: false, error: '目标不存在' })
  }

  db.prepare('DELETE FROM goals WHERE id = ? AND device_id = ?').run(id, deviceId)
  res.json({ success: true, message: '已删除' })
})

// 预算管理
router.get('/budgets', (req, res) => {
  const { deviceId } = req
  const month = new Date().toISOString().slice(0, 7)
  const budgets = db.prepare('SELECT * FROM budgets WHERE device_id = ?').all(deviceId)

  // 计算每个预算的实际支出
  const data = budgets.map(b => {
    let spent
    if (b.category) {
      const row = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM records
         WHERE device_id = ? AND type = 'expense' AND category = ? AND strftime('%Y-%m', date) = ?`
      ).get(deviceId, b.category, month)
      spent = row.total
    } else {
      const row = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM records
         WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?`
      ).get(deviceId, month)
      spent = row.total
    }
    return { ...b, spent, percent: b.amount > 0 ? Math.round(spent / b.amount * 100) : 0 }
  })

  res.json({ success: true, data })
})

router.post('/budgets', (req, res) => {
  const { deviceId } = req
  const { category, amount, period = 'monthly' } = req.body

  if (!amount) {
    return res.status(400).json({ success: false, error: '缺少必填字段: amount' })
  }

  // 如果已有同类预算，更新；否则插入
  const existing = db.prepare(
    'SELECT * FROM budgets WHERE device_id = ? AND category IS ? AND period = ?'
  ).get(deviceId, category || null, period)

  if (existing) {
    db.prepare('UPDATE budgets SET amount = ? WHERE id = ?').run(amount, existing.id)
  } else {
    db.prepare(
      'INSERT INTO budgets (device_id, category, amount, period) VALUES (?, ?, ?, ?)'
    ).run(deviceId, category || null, amount, period)
  }

  const budgets = db.prepare('SELECT * FROM budgets WHERE device_id = ?').all(deviceId)
  res.json({ success: true, data: budgets })
})

export default router
