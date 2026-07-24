import db from '../db.js'
import config from '../config.js'

// 目标货币对
const TARGETS = ['USD', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'AUD', 'THB']

// ========= Zhipu API 客户端 =========

async function callZhipu(messages, { temperature = 0.3, maxTokens = 800 } = {}) {
  const apiKey = config.ai.zhipuApiKey
  if (!apiKey) return null

  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'glm-4-flash',
      messages,
      temperature,
      max_tokens: maxTokens
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Zhipu API ${res.status}: ${text.slice(0, 200)}`)
  }

  const body = await res.json()
  return body.choices?.[0]?.message?.content || null
}

// ========= 数据获取 (Knex) =========

export async function fetchRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CNY')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const rows = []
    for (const cur of TARGETS) {
      if (json.rates[cur]) {
        rows.push({
          base: 'CNY',
          currency: cur,
          rate: 1 / json.rates[cur],
          fetched_at: now
        })
      }
    }

    if (rows.length > 0) {
      await db('exchange_rates').insert(rows)
    }

    console.log(`[Exchange] 汇率数据已更新 (${now}), ${rows.length} 货币对`)
    return true
  } catch (e) {
    console.error('[Exchange] 获取失败:', e.message)
    return false
  }
}

// ========= 数据查询 (Knex) =========

export async function getLatestRates() {
  const rates = {}
  for (const cur of TARGETS) {
    const row = await db('exchange_rates')
      .where('currency', cur)
      .orderBy('fetched_at', 'desc')
      .first()
    if (row) rates[cur] = row
  }
  return rates
}

export async function getLatestRate(currency) {
  return db('exchange_rates')
    .where('currency', currency)
    .orderBy('fetched_at', 'desc')
    .first() || null
}

export async function get24hChange(currency) {
  const latest = await db('exchange_rates')
    .where('currency', currency)
    .orderBy('fetched_at', 'desc')
    .first()
  if (!latest) return null

  const cutoff = new Date(latest.fetched_at)
  cutoff.setHours(cutoff.getHours() - 24)
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ')

  const prev = await db('exchange_rates')
    .where('currency', currency)
    .where('fetched_at', '<=', cutoffStr)
    .orderBy('fetched_at', 'desc')
    .first()
  if (!prev) return null

  const change = ((latest.rate - prev.rate) / prev.rate * 100)
  return { current: latest.rate, previous: prev.rate, change: +change.toFixed(4), time: latest.fetched_at }
}

export async function getHistory(currency, hours = 168) {
  return db('exchange_rates')
    .where('currency', currency)
    .whereRaw("fetched_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)", [hours])
    .orderBy('fetched_at', 'asc')
}

export async function getConsecutiveTrend(currency, days = 3) {
  const rows = await db('exchange_rates')
    .where('currency', currency)
    .whereRaw('fetched_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', [days * 2])
    .orderBy('fetched_at', 'asc')

  if (rows.length < days) return null

  // 按天分组取平均值
  const dailyAvg = {}
  for (const r of rows) {
    const day = String(r.fetched_at).slice(0, 10)
    if (!dailyAvg[day]) dailyAvg[day] = { sum: 0, count: 0 }
    dailyAvg[day].sum += Number(r.rate)
    dailyAvg[day].count++
  }

  const daysList = Object.entries(dailyAvg)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => ({ day, avg: d.sum / d.count }))

  if (daysList.length < days) return null

  const recent = daysList.slice(-days)
  let direction = 0
  for (let i = 1; i < recent.length; i++) {
    const change = (recent[i].avg - recent[i - 1].avg) / recent[i - 1].avg * 100
    if (Math.abs(change) < 0.1) continue
    if (direction === 0) direction = change > 0 ? 1 : -1
    else if ((change > 0 && direction === -1) || (change < 0 && direction === 1)) return null
  }

  if (direction === 0) return null
  const totalChange = ((recent[recent.length - 1].avg - recent[0].avg) / recent[0].avg * 100)
  return {
    direction: direction === 1 ? '上涨' : '下跌',
    days,
    totalChange: +totalChange.toFixed(2),
    data: recent
  }
}

// ========= 异常检测 =========

export async function detectAnomalies() {
  const alerts = []
  for (const cur of ['USD', 'EUR', 'JPY']) {
    const v = await checkVolatility(cur)
    if (v) alerts.push(v)
    const t = await checkConsecutiveTrendAnomaly(cur, 3)
    if (t) alerts.push(t)
    const b = await checkThresholdBreach(cur)
    if (b) alerts.push(b)
  }
  return alerts
}

async function checkVolatility(currency, threshold = 2) {
  const change = await get24hChange(currency)
  if (!change) return null
  if (Math.abs(change.change) >= threshold) {
    return {
      rule: 'volatility',
      level: 'warning',
      title: `⚠️ ${currency}/CNY 汇率大幅波动`,
      message: `${currency}/CNY 24小时变化 ${change.change > 0 ? '+' : ''}${change.change}%（当前 ${Number(change.current).toFixed(4)}），请关注汇率变化`,
      data: change
    }
  }
  return null
}

async function checkConsecutiveTrendAnomaly(currency, days = 3) {
  const trend = await getConsecutiveTrend(currency, days)
  if (!trend || Math.abs(trend.totalChange) < 1) return null
  return {
    rule: 'trend',
    level: 'info',
    title: `📈 ${currency}/CNY 连续${trend.days}天${trend.direction}`,
    message: `${currency}/CNY 连续${trend.days}天${trend.direction}，累计${trend.totalChange > 0 ? '+' : ''}${trend.totalChange}%，建议关注趋势`,
    data: trend
  }
}

function getThreshold(currency) {
  const thresholds = { USD: { low: 6.8, high: 7.5 }, EUR: { low: 7.0, high: 8.5 }, JPY: { low: 0.044, high: 0.050 } }
  return thresholds[currency] || null
}

async function checkThresholdBreach(currency) {
  const latest = await getLatestRate(currency)
  if (!latest) return null

  const t = getThreshold(currency)
  if (!t) return null

  if (Number(latest.rate) >= t.high) {
    return {
      rule: 'threshold_high',
      level: 'critical',
      title: `🔴 ${currency}/CNY 突破 ${t.high}`,
      message: `${currency}/CNY 当前 ${Number(latest.rate).toFixed(4)}，已突破${t.high}，建议关注换汇时机`,
      data: { rate: Number(latest.rate), threshold: t.high, direction: 'high' }
    }
  }
  if (Number(latest.rate) <= t.low) {
    return {
      rule: 'threshold_low',
      level: 'info',
      title: `🟢 ${currency}/CNY 跌破 ${t.low}`,
      message: `${currency}/CNY 当前 ${Number(latest.rate).toFixed(4)}，已跌破${t.low}，可能是换汇好时机`,
      data: { rate: Number(latest.rate), threshold: t.low, direction: 'low' }
    }
  }
  return null
}

// ========= Zhipu AI 分析 =========

export async function getRateAdvice(currency) {
  const change = await get24hChange(currency)
  const latest = await getLatestRate(currency)

  // 优先使用 Zhipu AI 生成个性化建议
  const aiAdvice = await generateAiAdvice(currency, { change, latest })
  if (aiAdvice) return aiAdvice

  // 降级：规则引擎
  if (!change) return null
  const advices = {
    USD: '建议使用人民币结算，暂缓大额美元消费',
    EUR: '欧元波动中，出行前关注汇率走势',
    JPY: '日元处于低位，是换汇的好时机'
  }

  if (change.change > 1) {
    return { advice: advices[currency] || `${currency}汇率上涨较多，建议使用人民币结算`, direction: 'up', change: change.change }
  }
  if (change.change < -1) {
    return { advice: `${currency}汇率下跌，现在是兑换${currency}的好时机`, direction: 'down', change: change.change }
  }
  return null
}

async function generateAiAdvice(currency, { change, latest }) {
  try {
    const currencyNames = { USD: '美元', EUR: '欧元', JPY: '日元', GBP: '英镑', HKD: '港币', KRW: '韩元', AUD: '澳元', THB: '泰铢' }
    const name = currencyNames[currency] || currency

    const messages = [
      { role: 'system', content: '你是一个专业的汇率分析师。请根据提供的汇率数据，给出简短实用的换汇/消费建议。用中文回答，控制在 80 字以内。' },
      { role: 'user', content: `当前 ${name}(${currency})/CNY 汇率: ${Number(latest?.rate || 0).toFixed(4)}。24小时变化: ${change ? (change.change > 0 ? '+' : '') + change.change + '%' : '未知'}。请给出换汇时机建议或出行消费建议。` }
    ]

    const text = await callZhipu(messages, { temperature: 0.4, maxTokens: 200 })
    if (!text) return null

    return {
      advice: text.trim(),
      direction: change ? (change.change > 0 ? 'up' : change.change < 0 ? 'down' : 'flat') : 'flat',
      change: change?.change || 0,
      source: 'zhipu-ai'
    }
  } catch (e) {
    console.warn(`[Exchange] Zhipu advice for ${currency} skipped:`, e.message)
    return null
  }
}

// ========= AI 周报 =========

export async function generateWeeklyReport() {
  const report = { generatedAt: new Date().toISOString(), currencies: {} }

  for (const cur of ['USD', 'EUR', 'JPY', 'GBP']) {
    const history = await getHistory(cur, 168)
    if (history.length === 0) continue

    const first = Number(history[0].rate)
    const last = Number(history[history.length - 1].rate)
    const weekChange = ((last - first) / first * 100)
    const vals = history.map(r => Number(r.rate))
    const high = Math.max(...vals)
    const low = Math.min(...vals)

    report.currencies[cur] = {
      start: first.toFixed(4),
      end: last.toFixed(4),
      weekChange: +weekChange.toFixed(2),
      high: high.toFixed(4),
      low: low.toFixed(4),
      trend: weekChange > 0 ? '上涨' : '下跌'
    }
  }

  // 尝试用 Zhipu 生成周报摘要
  try {
    const summary = await generateAiWeeklySummary(report)
    if (summary) report.summary = summary
  } catch {} // 静默降级

  return report
}

async function generateAiWeeklySummary(report) {
  const entries = Object.entries(report.currencies)
  if (entries.length === 0) return null

  const lines = entries.map(([cur, d]) =>
    `${cur}: ${d.start} → ${d.end} (${d.trend}${d.weekChange}%)`
  ).join('\n')

  const messages = [
    { role: 'system', content: '你是汇率分析师。根据本周各货币对CNY的汇率变化数据，生成一段简洁的周报摘要（100字内）。' },
    { role: 'user', content: `本周汇率变化：\n${lines}\n\n请生成周报摘要。` }
  ]

  return callZhipu(messages, { temperature: 0.5, maxTokens: 300 })
}

// ========= 汇率上下文摘要 =========

export async function getExchangeContext() {
  const rates = await getLatestRates()
  if (Object.keys(rates).length === 0) return ''

  const lines = ['## 当前汇率（CNY）']
  for (const [cur, data] of Object.entries(rates)) {
    const change = await get24hChange(cur)
    const arrow = change ? (change.change > 0 ? '↑' : '↓') : ''
    lines.push(`- ${cur}: ${Number(data.rate).toFixed(4)} ${arrow}`)
  }

  const anomalies = await detectAnomalies()
  if (anomalies.length > 0) {
    lines.push('\n## 汇率异常提醒')
    for (const a of anomalies) lines.push(`- ${a.title}: ${a.message}`)
  }

  for (const cur of ['USD', 'JPY']) {
    const advice = await getRateAdvice(cur)
    if (advice) lines.push(`\n💡 ${cur}建议: ${advice.advice}`)
  }

  return lines.join('\n')
}
