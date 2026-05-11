import db from '../db.js'

// 获取异常消费提醒
export function getAnomalies(deviceId) {
  const thisMonth = new Date().toISOString().slice(0, 7)
  const [y, m] = thisMonth.split('-').map(Number)
  const lastMonth = m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`

  const thisCategories = db.prepare(
    `SELECT category, SUM(amount) as total FROM records
     WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?
     GROUP BY category`
  ).all(deviceId, thisMonth)

  const lastCategories = db.prepare(
    `SELECT category, SUM(amount) as total FROM records
     WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?
     GROUP BY category`
  ).all(deviceId, lastMonth)

  const lastMap = {}
  for (const c of lastCategories) lastMap[c.category] = c.total

  const anomalies = []
  for (const c of thisCategories) {
    const prev = lastMap[c.category] || 0
    if (prev > 0) {
      const change = (c.total - prev) / prev * 100
      if (change > 50) {
        anomalies.push({ category: c.category, change: change.toFixed(0), current: c.total, previous: prev })
      }
    }
  }

  return anomalies
}

// 获取预算状态
export function getBudgetStatus(deviceId) {
  const month = new Date().toISOString().slice(0, 7)
  const budgets = db.prepare('SELECT * FROM budgets WHERE device_id = ?').all(deviceId)

  const status = []
  for (const b of budgets) {
    let actual
    if (b.category) {
      actual = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM records
         WHERE device_id = ? AND type = 'expense' AND category = ? AND strftime('%Y-%m', date) = ?`
      ).get(deviceId, b.category, month)
    } else {
      actual = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM records
         WHERE device_id = ? AND type = 'expense' AND strftime('%Y-%m', date) = ?`
      ).get(deviceId, month)
    }
    status.push({
      category: b.category || '总预算',
      budget: b.amount,
      spent: actual.total,
      remaining: b.amount - actual.total,
      percent: Math.round(actual.total / b.amount * 100)
    })
  }

  return status
}

// 获取AI上下文数据
export function getContextData(deviceId) {
  const month = new Date().toISOString().slice(0, 7)
  const today = new Date().toISOString().slice(0, 10)

  const monthlyStats = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
     FROM records WHERE device_id = ? AND strftime('%Y-%m', date) = ?`
  ).get(deviceId, month)

  const todayExpense = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM records
     WHERE device_id = ? AND date = ? AND type = 'expense'`
  ).get(deviceId, today)

  const recentRecords = db.prepare(
    `SELECT type, amount, category, description, date FROM records
     WHERE device_id = ? ORDER BY date DESC, created_at DESC LIMIT 10`
  ).all(deviceId)

  const anomalies = getAnomalies(deviceId)
  const budgets = getBudgetStatus(deviceId)

  return { monthlyStats, todayExpense: todayExpense.total, recentRecords, anomalies, budgets }
}
