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
  if (hints.category) query.where('category', hints.category)
  if (hints.type) query.where('type', hints.type)
  return query
}

function scopeText(hints = {}) {
  const parts = []
  if (hints.month) parts.push(hints.month)
  const typeText = hints.type === 'income' ? '收入' : hints.type === 'expense' ? '支出' : ''
  if (hints.category) parts.push(`${hints.category}${typeText}`)
  else if (typeText) parts.push(typeText)
  return parts.join(' ') || '当前条件'
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

  const baseQuery = applyFilters(dbClient('records'), { userId, hints })
  const records = (await baseQuery.orderBy('date', 'desc').select()).map(normalizeRecord)
  const total = records.reduce((sum, record) => sum + amountOf(record), 0)
  const maxRecord = records.reduce((max, record) => {
    if (!max) return record
    return amountOf(record) > amountOf(max) ? record : max
  }, null)

  const orderedRecords = hints.queryKind === 'largest'
    ? [...records].sort((a, b) => amountOf(b) - amountOf(a)).slice(0, limit)
    : records.slice(0, limit)

  return {
    hints,
    count: records.length,
    total,
    average: records.length ? total / records.length : 0,
    maxRecord,
    records: orderedRecords
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
