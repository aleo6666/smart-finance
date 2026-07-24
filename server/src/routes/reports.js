import { Router } from 'express'
import db from '../db.js'
import { v4 as uuid } from 'uuid'
import jwt from 'jsonwebtoken'
import config from '../config.js'
import { authMiddleware } from '../middleware/auth.js'

function getOptionalUserId(req) {
  try {
    const h = req.headers.authorization
    if (h && h.startsWith('Bearer ')) {
      return jwt.verify(h.slice(7), config.auth.jwtSecret).userId
    }
  } catch {}
  return null
}

function scopedRecords(dbClient, req, userId = getOptionalUserId(req)) {
  const query = dbClient('records')
  if (userId) query.where('user_id', userId)
  else query.where('device_id', req.deviceId)
  return query
}

async function monthlySummary(dbClient, req, month) {
  const rows = await scopedRecords(dbClient, req)
    .whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [month])
    .select('type')
    .sum({ total: 'amount_cny' })
    .count({ count: '*' })
    .groupBy('type')

  const income = Number(rows.find(row => row.type === 'income')?.total || 0)
  const expense = Number(rows.find(row => row.type === 'expense')?.total || 0)
  const recordCount = rows.reduce((sum, row) => sum + Number(row.count || 0), 0)
  return { income, expense, recordCount }
}

export function createReportsRouter({ dbClient = db, createToken = uuid } = {}) {
  const router = Router()

router.get('/monthly', authMiddleware, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  const stats = await monthlySummary(dbClient, req, month)
  res.json({
    success: true,
    data: {
      month,
      ...stats,
      balance: stats.income - stats.expense,
      change: 0,
      savingsRate: stats.income > 0 ? ((stats.income - stats.expense) / stats.income * 100).toFixed(1) : 0
    }
  })
})

router.get('/category', authMiddleware, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  const categories = await scopedRecords(dbClient, req)
    .where('type', 'expense')
    .whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [month])
    .select('category')
    .sum({ total: 'amount_cny' })
    .count({ count: '*' })
    .groupBy('category')
    .orderBy('total', 'desc')
  res.json({ success: true, data: categories })
})

router.get('/trend', authMiddleware, async (req, res) => {
  const months = Number(req.query.months) || 6
  const trends = await scopedRecords(dbClient, req)
    .whereRaw('date >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)', [months])
    .select(dbClient.raw('DATE_FORMAT(date, "%Y-%m") as month'))
    .sum({ income: dbClient.raw("CASE WHEN type='income' THEN amount_cny ELSE 0 END") })
    .sum({ expense: dbClient.raw("CASE WHEN type='expense' THEN amount_cny ELSE 0 END") })
    .groupBy('month')
    .orderBy('month')
  res.json({ success: true, data: trends })
})

router.get('/today', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const row = await scopedRecords(dbClient, req)
    .where({ date: today, type: 'expense' })
    .sum({ total: 'amount_cny' })
    .count({ count: '*' })
    .first()
  res.json({ success: true, data: { date: today, total: Number(row?.total || 0), count: Number(row?.count || 0) } })
})

router.get('/timerange', authMiddleware, async (req, res) => {
  const period = req.query.period || 'month'
  const today = new Date()
  const days = period === 'week' ? 6 : period === 'quarter' ? 90 : 29
  const from = new Date(today)
  from.setDate(from.getDate() - days)
  const fromDate = from.toISOString().slice(0, 10)
  const toDate = today.toISOString().slice(0, 10)

  const [trendRows, categoryRows, countRow] = await Promise.all([
    scopedRecords(dbClient, req)
      .whereBetween('date', [fromDate, toDate])
      .select(dbClient.raw('DATE_FORMAT(date, "%Y-%m-%d") as label'))
      .sum({ income: dbClient.raw("CASE WHEN type='income' THEN amount_cny ELSE 0 END") })
      .sum({ expense: dbClient.raw("CASE WHEN type='expense' THEN amount_cny ELSE 0 END") })
      .groupBy('label')
      .orderBy('label'),
    scopedRecords(dbClient, req)
      .whereBetween('date', [fromDate, toDate])
      .where('type', 'expense')
      .select('category')
      .sum({ total: 'amount_cny' })
      .count({ count: '*' })
      .groupBy('category')
      .orderBy('total', 'desc'),
    scopedRecords(dbClient, req)
      .whereBetween('date', [fromDate, toDate])
      .count({ count: '*' })
      .first()
  ])

  const income = trendRows.reduce((sum, row) => sum + Number(row.income || 0), 0)
  const expense = trendRows.reduce((sum, row) => sum + Number(row.expense || 0), 0)
  const recordCount = Number(countRow?.count || 0)

  res.json({
    success: true,
    data: { period, fromDate, toDate, income, expense, balance: income - expense, count: recordCount, savingsRate: income > 0 ? ((income - expense) / income * 100).toFixed(1) : 0, trends: trendRows, categories: categoryRows }
  })
})

router.get('/summary', authMiddleware, async (req, res) => {
  const periodValue = req.query.periodValue || new Date().toISOString().slice(0, 7)
  const stats = await monthlySummary(dbClient, req, periodValue)
  res.json({ success: true, data: { periodType: req.query.periodType || 'month', periodValue, ...stats } })
})

router.post('/generate', authMiddleware, async (req, res) => {
  const { periodType = 'month', periodValue = new Date().toISOString().slice(0, 7), ledgerId } = req.body
  const row = await dbClient('reports')
    .where({ user_id: req.userId, source: 'manual' })
    .whereRaw('DATE(generated_at) = CURDATE()')
    .count({ count: '*' })
    .first()
  if (Number(row?.count || 0) >= 5) return res.status(429).json({ success: false, error: '今日手动生成次数已达上限(5)' })

  const report = await monthlySummary(dbClient, req, periodValue)
  const [reportId] = await dbClient('reports').insert({ user_id: req.userId, ledger_id: ledgerId ? Number(ledgerId) : null, period_type: periodType, period_value: periodValue, source: 'manual', summary_json: JSON.stringify(report) })
  res.json({ success: true, data: { reportId } })
})

router.get('/history', authMiddleware, async (req, res) => {
  const reports = await dbClient('reports')
    .select('id', 'period_type', 'period_value', 'source', 'generated_at')
    .where({ user_id: req.userId })
    .orderBy('generated_at', 'desc')
    .limit(50)
  res.json({ success: true, data: reports })
})

router.post('/share/:id', authMiddleware, async (req, res) => {
  const reportId = Number(req.params.id)
  const report = await dbClient('reports').where({ id: reportId, user_id: req.userId }).first()
  if (!report) return res.status(404).json({ success: false, error: '报表不存在' })

  const token = createToken()
  const exp = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 19).replace('T', ' ')
  await dbClient('report_shares').insert({ report_id: reportId, token, expire_at: exp })
  res.json({ success: true, data: { url: `${req.protocol}://${req.get('host')}/api/share/${token}` } })
})

  return router
}

export default createReportsRouter()
