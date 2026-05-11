import { Router } from 'express'
import db from '../db.js'

const router = Router()

// 月度汇总
router.get('/monthly', (req, res) => {
  const { deviceId } = req
  const month = req.query.month || new Date().toISOString().slice(0, 7)

  const income = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM records
     WHERE device_id = ? AND type = 'income' AND strftime('%Y-%m', date) = ?`
  ).get(deviceId, month)

  const expense = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM records
     WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?`
  ).get(deviceId, month)

  const recordCount = db.prepare(
    `SELECT COUNT(*) as count FROM records
     WHERE device_id = ? AND strftime('%Y-%m', date) = ?`
  ).get(deviceId, month)

  // 上月数据用于环比
  const [y, m] = month.split('-').map(Number)
  const lastMonth = m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`

  const lastExpense = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM records
     WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?`
  ).get(deviceId, lastMonth)

  const change = lastExpense.total > 0
    ? ((expense.total - lastExpense.total) / lastExpense.total * 100).toFixed(1)
    : 0

  res.json({
    success: true,
    data: {
      month,
      income: income.total,
      expense: expense.total,
      balance: income.total - expense.total,
      recordCount: recordCount.count,
      change,
      savingsRate: income.total > 0 ? ((income.total - expense.total) / income.total * 100).toFixed(1) : 0
    }
  })
})

// 分类统计
router.get('/category', (req, res) => {
  const { deviceId } = req
  const month = req.query.month || new Date().toISOString().slice(0, 7)

  const categories = db.prepare(
    `SELECT category, SUM(amount) as total, COUNT(*) as count
     FROM records
     WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?
     GROUP BY category ORDER BY total DESC`
  ).all(deviceId, month)

  res.json({ success: true, data: categories })
})

// 趋势数据（近N个月）
router.get('/trend', (req, res) => {
  const { deviceId } = req
  const months = Number(req.query.months) || 6

  const trends = db.prepare(
    `SELECT strftime('%Y-%m', date) as month,
       SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
       SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense
     FROM records
     WHERE device_id = ? AND date >= date('now', ? || ' months')
     GROUP BY month ORDER BY month`
  ).all(deviceId, `-${months}`)

  res.json({ success: true, data: trends })
})

// 今日汇总
router.get('/today', (req, res) => {
  const { deviceId } = req
  const today = new Date().toISOString().slice(0, 10)

  const result = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
     FROM records WHERE device_id = ? AND date = ? AND type = 'expense'`
  ).get(deviceId, today)

  res.json({ success: true, data: { date: today, total: result.total, count: result.count } })
})

export default router
