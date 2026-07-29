import db from '../db.js'

function amountOf(record) {
  return Number(record.amount_cny ?? record.amount ?? 0)
}

function normalizeRecord(record) {
  return {
    ...record,
    amount: amountOf(record),
    amount_cny: amountOf(record)
  }
}

function applyFilters(query, { userId, hints = {} }) {
  query.where('user_id', userId)
  if (hints.month) query.whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [hints.month])
  if (hints.startDate) query.where('date', '>=', hints.startDate)
  if (hints.endDate) query.where('date', '<=', hints.endDate)
  if (hints.ledgerId) query.where('ledger_id', hints.ledgerId)
  if (hints.category) query.where('category', hints.category)
  if (hints.type) query.where('type', hints.type)
  return query
}

function scopeText(hints = {}) {
  const parts = []
  const now = new Date()
  const thisMonth = now.toISOString().slice(0, 7)
  if (hints.month) {
    parts.push(hints.month === thisMonth ? '本月' : hints.month)
  }
  const typeText = hints.type === 'income' ? '收入' : hints.type === 'expense' ? '支出' : ''
  if (hints.category) parts.push(`${hints.category}${typeText}`)
  else if (typeText) parts.push(typeText)
  return parts.join(' ') || '全部'
}

export async function queryFinanceSummary({
  userId,
  hints = {},
  db: dbClient = db,
  limit = 5
} = {}) {
  if (!userId) {
    return { hints, count: 0, total: 0, average: 0, maxRecord: null, records: [] }
  }

  const aggregateRows = await applyFilters(dbClient('records'), { userId, hints })
    .select(
      dbClient.raw('COUNT(*) as count'),
      dbClient.raw('SUM(COALESCE(amount_cny, amount)) as total')
    )
  const aggregate = aggregateRows[0] || {}

  const maxRows = await applyFilters(dbClient('records'), { userId, hints })
    .orderByRaw('COALESCE(amount_cny, amount) DESC')
    .limit(1)
    .select()
  const maxRecord = maxRows[0] ? normalizeRecord(maxRows[0]) : null

  const displayQuery = applyFilters(dbClient('records'), { userId, hints })
  if (hints.queryKind === 'largest') {
    displayQuery.orderByRaw('COALESCE(amount_cny, amount) DESC')
  } else {
    displayQuery.orderBy('date', 'desc')
  }
  const records = (await displayQuery.limit(limit).select()).map(normalizeRecord)
  const count = Number(aggregate.count || 0)
  const total = Number(aggregate.total || 0)

  return {
    hints,
    count,
    total,
    average: count ? total / count : 0,
    maxRecord,
    records
  }
}

export function buildFinanceQueryReply(summary) {
  const label = scopeText(summary.hints)
  if (!summary.count) return `没找到${label}记录。你可以先记一笔，例如“今天餐饮花了25元”。`

  if (summary.hints?.queryKind === 'recent') {
    const details = summary.records.map(record => `${record.date} ${Number(record.amount).toFixed(2)} 元${record.description ? `（${record.description}）` : ''}`).join('，')
    return `最近找到 ${summary.records.length} 笔${label}记录：${details}。`
  }

  if (summary.hints?.queryKind === 'largest') {
    const record = summary.maxRecord
    return `${label}最大一笔是 ${Number(record.amount).toFixed(2)} 元，记录在 ${record.date}${record.description ? `（${record.description}）` : ''}。`
  }

  const maxText = summary.maxRecord ? `，最大一笔是 ${Number(summary.maxRecord.amount).toFixed(2)} 元` : ''
  return `${label}共 ${summary.total.toFixed(2)} 元，合计 ${summary.count} 笔，平均每笔 ${summary.average.toFixed(2)} 元${maxText}。`
}
