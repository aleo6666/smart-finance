import { Router } from 'express'
import {
  getLatestRates, get24hChange, getHistory, getConsecutiveTrend,
  detectAnomalies, getRateAdvice, generateWeeklyReport,
  getExchangeContext
} from '../services/exchangeRate.js'

const router = Router()

// 获取最新汇率
router.get('/latest', async (req, res) => {
  const rates = await getLatestRates()
  const data = {}
  for (const [cur, row] of Object.entries(rates)) {
    const change = await get24hChange(cur)
    data[cur] = {
      rate: row.rate,
      updatedAt: row.fetched_at,
      change24h: change ? +change.change.toFixed(2) : null
    }
  }
  res.json({ success: true, data })
})

// 获取单个货币详情（含历史+趋势+建议）
router.get('/detail/:currency', async (req, res) => {
  const { currency } = req.params
  const latest = await getLatestRates()
  const history = await getHistory(currency.toUpperCase(), 168)
  const trend = await getConsecutiveTrend(currency.toUpperCase(), 3)
  const change = await get24hChange(currency.toUpperCase())
  const advice = await getRateAdvice(currency.toUpperCase())
  const weekly = await generateWeeklyReport()

  res.json({
    success: true,
    data: {
      currency: currency.toUpperCase(),
      current: latest[currency.toUpperCase()]?.rate || null,
      change24h: change,
      history: history.slice(-48),
      trend,
      advice,
      weeklyReport: weekly.currencies[currency.toUpperCase()] || null
    }
  })
})

// 异常检测
router.get('/alerts', async (req, res) => {
  const alerts = await detectAnomalies()
  res.json({ success: true, data: alerts })
})

// 周报
router.get('/weekly', async (req, res) => {
  const report = await generateWeeklyReport()
  res.json({ success: true, data: report })
})

// 汇率上下文（供前端展示）
router.get('/context', async (req, res) => {
  const context = await getExchangeContext()
  res.json({ success: true, data: context })
})

export default router
