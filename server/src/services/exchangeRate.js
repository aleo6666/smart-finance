import db from '../db.js'

// 目标货币对
const TARGETS = ['USD', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'AUD', 'THB']

// ========= 数据获取 =========

export async function fetchRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CNY')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const insert = db.prepare(
      'INSERT INTO exchange_rates (base, currency, rate, fetched_at) VALUES (?, ?, ?, ?)'
    )

    const tx = db.transaction(() => {
      for (const cur of TARGETS) {
        if (json.rates[cur]) {
          // 反转: API 返回 1 CNY = X 外币，我们存 1 外币 = Y CNY
          insert.run('CNY', cur, 1 / json.rates[cur], now)
        }
      }
    })

    tx()
    console.log(`[Exchange] 汇率数据已更新 (${now})`)
    return true
  } catch (e) {
    console.error('[Exchange] 获取失败:', e.message)
    return false
  }
}

// ========= 数据查询 =========

// 获取最新汇率（所有货币）
export function getLatestRates() {
  const rates = {}
  for (const cur of TARGETS) {
    const row = db.prepare(
      `SELECT rate, fetched_at FROM exchange_rates
       WHERE currency = ? ORDER BY fetched_at DESC LIMIT 1`
    ).get(cur)
    if (row) rates[cur] = row
  }
  return rates
}

// 获取单个货币最新汇率
export function getLatestRate(currency) {
  return db.prepare(
    `SELECT rate, fetched_at FROM exchange_rates
     WHERE currency = ? ORDER BY fetched_at DESC LIMIT 1`
  ).get(currency) || null
}

// 获取24小时变化
export function get24hChange(currency) {
  const latest = db.prepare(
    `SELECT rate, fetched_at FROM exchange_rates
     WHERE currency = ? ORDER BY fetched_at DESC LIMIT 1`
  ).get(currency)
  if (!latest) return null

  const prev = db.prepare(
    `SELECT rate FROM exchange_rates
     WHERE currency = ? AND fetched_at <= datetime(?, '-24 hours')
     ORDER BY fetched_at DESC LIMIT 1`
  ).get(currency, latest.fetched_at)
  if (!prev) return null

  const change = ((latest.rate - prev.rate) / prev.rate * 100)
  return { current: latest.rate, previous: prev.rate, change: +change.toFixed(4), time: latest.fetched_at }
}

// 获取历史数据（用于趋势图，默认7天）
export function getHistory(currency, hours = 168) {
  return db.prepare(
    `SELECT rate, fetched_at FROM exchange_rates
     WHERE currency = ? AND fetched_at >= datetime('now', ? || ' hours')
     ORDER BY fetched_at ASC`
  ).all(currency, `-${hours}`)
}

// 获取连续N天变化方向
export function getConsecutiveTrend(currency, days = 3) {
  const rows = db.prepare(
    `SELECT fetched_at, rate FROM (
       SELECT fetched_at, rate,
              date(fetched_at) as day,
              LAG(rate) OVER (ORDER BY fetched_at) as prev_rate
       FROM exchange_rates WHERE currency = ?
       AND fetched_at >= datetime('now', ? || ' days')
       ORDER BY fetched_at
     )`
  ).all(currency, `-${days * 2}`)

  if (rows.length < days) return null

  // 按天分组取平均值
  const dailyAvg = {}
  for (const r of rows) {
    const day = r.fetched_at.slice(0, 10)
    if (!dailyAvg[day]) dailyAvg[day] = { sum: 0, count: 0 }
    dailyAvg[day].sum += r.rate
    dailyAvg[day].count++
  }

  const days_list = Object.entries(dailyAvg)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => ({ day, avg: d.sum / d.count }))

  if (days_list.length < days) return null

  // 检查最近N天是否单向变化
  const recent = days_list.slice(-days)
  let direction = 0 // 0=未知, 1=连续上涨, -1=连续下跌
  for (let i = 1; i < recent.length; i++) {
    const change = (recent[i].avg - recent[i - 1].avg) / recent[i - 1].avg * 100
    if (Math.abs(change) < 0.1) continue // 忽略微小波动
    if (direction === 0) direction = change > 0 ? 1 : -1
    else if ((change > 0 && direction === -1) || (change < 0 && direction === 1)) {
      return null // 方向不一致
    }
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

// 规则1: 24小时波动超过±2%
export function checkVolatility(currency, threshold = 2) {
  const change = get24hChange(currency)
  if (!change) return null
  if (Math.abs(change.change) >= threshold) {
    return {
      rule: 'volatility',
      level: 'warning',
      title: `⚠️ ${currency}/CNY 汇率大幅波动`,
      message: `${currency}/CNY 24小时变化 ${change.change > 0 ? '+' : ''}${change.change}%（当前 ${change.current.toFixed(4)}），请关注汇率变化`,
      data: change
    }
  }
  return null
}

// 规则2: 连续N天单向变化超过±1%
export function checkConsecutiveTrend(currency) {
  const trend = getConsecutiveTrend(currency, 3)
  if (!trend || Math.abs(trend.totalChange) < 1) return null
  return {
    rule: 'trend',
    level: 'info',
    title: `📈 ${currency}/CNY 连续${trend.days}天${trend.direction}`,
    message: `${currency}/CNY 连续${trend.days}天${trend.direction}，累计${trend.totalChange > 0 ? '+' : ''}${trend.totalChange}%，建议关注趋势`,
    data: trend
  }
}

// 规则3: 关键阈值突破
function getThreshold(currency) {
  const thresholds = { USD: { low: 6.8, high: 7.5 }, EUR: { low: 7.0, high: 8.5 }, JPY: { low: 0.044, high: 0.050 } }
  return thresholds[currency] || null
}

export function checkThresholdBreach(currency) {
  const latest = getLatestRate(currency)
  if (!latest) return null

  const t = getThreshold(currency)
  if (!t) return null

  if (latest.rate >= t.high) {
    return {
      rule: 'threshold_high',
      level: 'critical',
      title: `🔴 ${currency}/CNY 突破 ${t.high}`,
      message: `${currency}/CNY 当前 ${latest.rate.toFixed(4)}，已突破${t.high}，建议关注换汇时机`,
      data: { rate: latest.rate, threshold: t.high, direction: 'high' }
    }
  }
  if (latest.rate <= t.low) {
    return {
      rule: 'threshold_low',
      level: 'info',
      title: `🟢 ${currency}/CNY 跌破 ${t.low}`,
      message: `${currency}/CNY 当前 ${latest.rate.toFixed(4)}，已跌破${t.low}，可能是换汇好时机`,
      data: { rate: latest.rate, threshold: t.low, direction: 'low' }
    }
  }
  return null
}

// 综合异常检测（三种规则全跑）
export function detectAnomalies() {
  const alerts = []
  for (const cur of ['USD', 'EUR', 'JPY']) {
    const v = checkVolatility(cur)
    if (v) alerts.push(v)
    const t = checkConsecutiveTrend(cur)
    if (t) alerts.push(t)
    const b = checkThresholdBreach(cur)
    if (b) alerts.push(b)
  }
  return alerts
}

// ========= 联动规则（L3） =========

// 规则1: 汇率影响消费建议
export function getRateAdvice(currency) {
  const change = get24hChange(currency)
  if (!change) return null

  const advices = {
    USD: '建议使用人民币结算，暂缓大额美元消费',
    EUR: '欧元波动中，出行前关注汇率走势',
    JPY: '日元处于低位，是换汇的好时机'
  }

  if (change.change > 1) {
    return {
      advice: advices[currency] || `${currency}汇率上涨较多，建议使用人民币结算`,
      direction: 'up',
      change: change.change
    }
  }
  if (change.change < -1) {
    return {
      advice: `${currency}汇率下跌，现在是兑换${currency}的好时机`,
      direction: 'down',
      change: change.change
    }
  }
  return null
}

// 获取汇率上下文摘要（注入NLU Prompt）
export function getExchangeContext() {
  const rates = getLatestRates()
  if (Object.keys(rates).length === 0) return ''

  const lines = ['## 当前汇率（CNY）']
  for (const [cur, data] of Object.entries(rates)) {
    const change = get24hChange(cur)
    const arrow = change ? (change.change > 0 ? '↑' : '↓') : ''
    lines.push(`- ${cur}: ${data.rate.toFixed(4)} ${arrow}`)
  }

  // 异常检测
  const anomalies = detectAnomalies()
  if (anomalies.length > 0) {
    lines.push('\n## 汇率异常提醒')
    for (const a of anomalies) {
      lines.push(`- ${a.title}: ${a.message}`)
    }
  }

  // 联动建议
  for (const cur of ['USD', 'JPY']) {
    const advice = getRateAdvice(cur)
    if (advice) {
      lines.push(`\n💡 ${cur}建议: ${advice.advice}`)
    }
  }

  return lines.join('\n')
}

// ========= 周报 =========

export function generateWeeklyReport() {
  const report = { generatedAt: new Date().toISOString(), currencies: {} }

  for (const cur of ['USD', 'EUR', 'JPY', 'GBP']) {
    const history = getHistory(cur, 168)
    if (history.length === 0) continue

    const first = history[0].rate
    const last = history[history.length - 1].rate
    const weekChange = ((last - first) / first * 100).toFixed(2)
    const high = Math.max(...history.map(r => r.rate))
    const low = Math.min(...history.map(r => r.rate))

    report.currencies[cur] = {
      start: first.toFixed(4),
      end: last.toFixed(4),
      weekChange: +weekChange,
      high: high.toFixed(4),
      low: low.toFixed(4),
      trend: weekChange > 0 ? '上涨' : '下跌'
    }
  }

  return report
}
