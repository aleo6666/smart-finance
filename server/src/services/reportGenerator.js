import db from '../db.js'

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function periodRange(type, value) {
  if (type === 'month') {
    const [year, month] = value.split('-').map(Number)
    const end = formatLocalDate(new Date(year, month, 0))
    return { start: `${value}-01`, end }
  }
  if (type === 'year') {
    return { start: `${value}-01-01`, end: `${value}-12-31` }
  }
  if (type === 'quarter') {
    const [year, quarter] = value.split('-Q').map(Number)
    const startMonth = (quarter - 1) * 3 + 1
    const endMonth = quarter * 3
    const end = formatLocalDate(new Date(year, endMonth, 0))
    return { start: `${year}-${String(startMonth).padStart(2, '0')}-01`, end }
  }
  if (type === 'week') {
    const [year, month, day] = value.split('-').map(Number)
    const endDate = new Date(year, month - 1, day)
    endDate.setDate(endDate.getDate() + 6)
    return { start: value, end: formatLocalDate(endDate) }
  }
  return { start: '0000-01-01', end: '9999-12-31' }
}

function applyReportFilters(query, { userId, ledgerId, start, end, filters }) {
  query.where('r.user_id', userId)
  query.whereRaw('r.date >= ? AND r.date <= ?', [start, end])
  if (ledgerId) query.where('r.ledger_id', Number(ledgerId))
  if (filters.category) query.where('r.category', filters.category)
  if (filters.member) query.where('r.member', filters.member)
  if (filters.merchant) query.whereRaw('r.merchant LIKE ?', [`%${filters.merchant}%`])
  if (filters.project) query.where('r.project', filters.project)
  return query
}

function amountOf(row) {
  return Number(row.amount_cny ?? row.amount ?? 0)
}

export async function buildReport({
  userId,
  ledgerId = null,
  periodType = 'month',
  periodValue = formatLocalDate(new Date()).slice(0, 7),
  filters = {},
  db: dbClient = db
} = {}) {
  const { start, end } = periodRange(periodType, periodValue)
  const requestedLimit = Number(filters.limit)
  const requestedOffset = Number(filters.offset)
  const integerLimit = Math.floor(requestedLimit)
  const limit = Number.isFinite(integerLimit) && integerLimit >= 1
    ? Math.min(integerLimit, 2000)
    : 2000
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? Math.floor(requestedOffset)
    : 0
  const scoped = () => applyReportFilters(
    dbClient('records as r'),
    { userId, ledgerId, start, end, filters }
  )

  const totals = await scoped()
    .select('r.type')
    .sum({ total: dbClient.raw('COALESCE(r.amount_cny, r.amount)') })
    .count({ count: '*' })
    .groupBy('r.type')

  const income = Number(totals.find(row => row.type === 'income')?.total || 0)
  const expense = Number(totals.find(row => row.type === 'expense')?.total || 0)

  const incomeByCurrency = await scoped()
    .where('r.type', 'income')
    .select('r.currency')
    .sum({ total: 'r.amount' })
    .groupBy('r.currency')

  const expenseByCurrency = await scoped()
    .where('r.type', 'expense')
    .select('r.currency')
    .sum({ total: 'r.amount' })
    .groupBy('r.currency')

  const byCategory = await scoped()
    .where('r.type', 'expense')
    .select('r.category')
    .sum({ total: dbClient.raw('COALESCE(r.amount_cny, r.amount)') })
    .count({ count: '*' })
    .groupBy('r.category')
    .orderBy('total', 'desc')

  const sortOrder = filters.sortOrder === 'asc' ? 'asc' : 'desc'
  const sortBy = filters.sortBy === 'amount'
    ? dbClient.raw('COALESCE(r.amount_cny, r.amount)')
    : 'r.date'
  const records = await scoped()
    .select('r.*', dbClient.raw('COALESCE(r.amount_cny, r.amount) as amount_cny'))
    .orderBy(sortBy, sortOrder)
    .orderBy('r.id', sortOrder)
    .limit(limit)
    .offset(offset)

  return {
    period: { type: periodType, value: periodValue, start, end },
    income,
    expense,
    balance: income - expense,
    incomeByCurrency,
    expenseByCurrency,
    byCategory,
    count: records.length,
    records: records.map(record => ({ ...record, amount_cny: amountOf(record) }))
  }
}
