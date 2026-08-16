import { Router } from 'express'
import db from '../db.js'
import { createLogger } from '../utils/logger.js'
import { authMiddleware } from '../middleware/auth.js'

const ASSET_TYPES = ['deposit', 'fund', 'stock', 'liability']
const CURVE_DAYS = 30

const logger = createLogger('Assets')

function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function lastNDates(n) {
  const today = new Date()
  return Array.from({ length: n }, (_, index) => toDateString(addDays(today, -(n - 1 - index))))
}

function snapshotDate(value) {
  if (value instanceof Date) return toDateString(value)
  return String(value).slice(0, 10)
}

function roundMoney(value) {
  return Math.round(value * 10000) / 10000
}

function validateBalance(balance) {
  return typeof balance === 'number' && Number.isFinite(balance) && balance >= 0
}

export function createAssetsRouter({ dbClient = db } = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/', async (req, res) => {
    const assets = await dbClient('assets').where({ user_id: req.userId }).orderBy('created_at', 'desc')
    const grouped = { deposit: [], fund: [], stock: [], liability: [] }
    for (const asset of assets) {
      if (grouped[asset.type]) grouped[asset.type].push(asset)
    }
    res.json({ success: true, data: grouped })
  })

  router.post('/', async (req, res) => {
    const { name, type, balance, currency = 'CNY', note } = req.body || {}
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: '缺少必填字段: name' })
    }
    if (!ASSET_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: 'type 必须是 deposit/fund/stock/liability 之一' })
    }
    if (!validateBalance(balance)) {
      return res.status(400).json({ success: false, error: 'balance 必须是大于等于 0 的数字' })
    }
    const [id] = await dbClient('assets').insert({
      user_id: req.userId,
      name: name.trim(),
      type,
      balance,
      currency: currency || 'CNY',
      note: note == null ? null : String(note)
    })
    logger.info('新增资产账户', { userId: req.userId, assetId: id, name, type })
    res.json({ success: true, data: await dbClient('assets').where({ id, user_id: req.userId }).first() })
  })

  router.put('/:id', async (req, res) => {
    const asset = await dbClient('assets').where({ id: req.params.id, user_id: req.userId }).first()
    if (!asset) return res.status(404).json({ success: false, error: '账户不存在' })

    const updates = {}
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).json({ success: false, error: 'name 不能为空' })
      }
      updates.name = req.body.name.trim()
    }
    if (req.body.balance !== undefined) {
      if (!validateBalance(req.body.balance)) {
        return res.status(400).json({ success: false, error: 'balance 必须是大于等于 0 的数字' })
      }
      updates.balance = req.body.balance
    }
    if (req.body.note !== undefined) {
      updates.note = req.body.note == null ? null : String(req.body.note)
    }
    if (Object.keys(updates).length) {
      await dbClient('assets').where({ id: req.params.id, user_id: req.userId }).update(updates)
    }
    logger.info('更新资产账户', { userId: req.userId, assetId: req.params.id })
    res.json({ success: true, data: await dbClient('assets').where({ id: req.params.id, user_id: req.userId }).first() })
  })

  router.delete('/:id', async (req, res) => {
    const deleted = await dbClient('assets').where({ id: req.params.id, user_id: req.userId }).delete()
    if (!deleted) return res.status(404).json({ success: false, error: '账户不存在' })
    logger.info('删除资产账户', { userId: req.userId, assetId: req.params.id })
    res.json({ success: true, message: '已删除' })
  })

  router.get('/overview', async (req, res) => {
    const userId = req.userId
    const grouped = await dbClient('assets')
      .where({ user_id: userId })
      .select('type')
      .sum({ total: 'balance' })
      .groupBy('type')

    const totalsByType = { deposit: 0, fund: 0, stock: 0, liability: 0 }
    for (const row of grouped) {
      if (totalsByType[row.type] !== undefined) {
        totalsByType[row.type] = roundMoney(Number(row.total) || 0)
      }
    }

    const totalAssets = roundMoney(totalsByType.deposit + totalsByType.fund + totalsByType.stock)
    const totalLiabilities = totalsByType.liability
    const netWorth = roundMoney(totalAssets - totalLiabilities)

    const today = toDateString(new Date())
    const todaySnapshot = { total_assets: totalAssets, total_liabilities: totalLiabilities, net_worth: netWorth }
    await dbClient('daily_balance_snapshots')
      .insert({ user_id: userId, snapshot_date: today, ...todaySnapshot })
      .onConflict(['user_id', 'snapshot_date'])
      .merge(todaySnapshot)

    const dates = lastNDates(CURVE_DAYS)
    const rows = await dbClient('daily_balance_snapshots')
      .where({ user_id: userId })
      .where('snapshot_date', '>=', dates[0])
      .orderBy('snapshot_date', 'asc')

    const byDate = new Map(rows.map(row => [snapshotDate(row.snapshot_date), row]))
    const curve = []
    let last = { total_assets: 0, total_liabilities: 0, net_worth: 0 }
    for (const date of dates) {
      const row = byDate.get(date)
      if (row) {
        last = {
          total_assets: roundMoney(Number(row.total_assets) || 0),
          total_liabilities: roundMoney(Number(row.total_liabilities) || 0),
          net_worth: roundMoney(Number(row.net_worth) || 0)
        }
      }
      curve.push({ date, ...last })
    }

    const breakdown = ASSET_TYPES.map(type => ({
      type,
      total: totalsByType[type],
      percent: totalAssets > 0 ? Math.round(totalsByType[type] / totalAssets * 10000) / 100 : 0
    }))

    res.json({
      success: true,
      data: {
        summary: { total_assets: totalAssets, total_liabilities: totalLiabilities, net_worth: netWorth },
        breakdown,
        curve
      }
    })
  })

  return router
}

export default createAssetsRouter()
