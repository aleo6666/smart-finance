/**
 * 财务记录查询构建器 — financeQuery.js 和 domainTools.js 的公共抽象
 * 消除了两处对 records 表的重复筛选/聚合/标准化逻辑
 */

/**
 * @param {object} record - 数据库原始记录
 * @returns {object} - 统一标准化后的记录
 */
export function normalizeRecord(record) {
  const amount = Number(record.amount_cny ?? record.amount ?? 0)
  return {
    ...record,
    amount,
    amount_cny: amount
  }
}

/**
 * 将筛选提示应用到 Knex 查询
 * @param {object} query - Knex 查询对象
 * @param {{ userId: number, hints: object }} params
 * @returns {object} - 修改后的查询对象
 */
export function applyRecordFilters(query, { userId, hints = {} }) {
  query.where('user_id', userId)
  if (hints.month) query.whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [hints.month])
  if (hints.startDate) query.where('date', '>=', hints.startDate)
  if (hints.endDate) query.where('date', '<=', hints.endDate)
  if (hints.ledgerId) query.where('ledger_id', hints.ledgerId)
  if (hints.category) query.where('category', hints.category)
  if (hints.type) query.where('type', hints.type)
  return query
}

/**
 * 按筛选条件查询财务汇总
 * @param {object} options
 * @returns {object} { hints, count, total, average, maxRecord, records }
 */
export async function queryFinanceSummary({
  userId,
  hints = {},
  dbClient,
  limit = 5
}) {
  if (!userId || !dbClient) {
    return { hints, count: 0, total: 0, average: 0, maxRecord: null, records: [] }
  }

  const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 5))

  const baseQuery = () => applyRecordFilters(dbClient('records'), { userId, hints })

  // 聚合查询
  const aggregateRows = await baseQuery().select(
    dbClient.raw('COUNT(*) as count'),
    dbClient.raw('SUM(COALESCE(amount_cny, amount)) as total')
  )
  const aggregate = aggregateRows[0] || {}

  // 最大单笔查询
  const maxRows = await baseQuery()
    .orderByRaw('COALESCE(amount_cny, amount) DESC')
    .limit(1)
    .select()
  const maxRecord = maxRows[0] ? normalizeRecord(maxRows[0]) : null

  // 明细查询
  const recordsQuery = baseQuery()
  if (hints.queryKind === 'largest') {
    recordsQuery.orderByRaw('COALESCE(amount_cny, amount) DESC')
  } else {
    recordsQuery.orderBy('date', 'desc')
  }
  const records = (await recordsQuery.limit(boundedLimit).select()).map(normalizeRecord)

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

/**
 * 按分类统计聚合
 */
export async function queryFinanceCategoryStats({
  userId,
  hints,
  dbClient
}) {
  if (!userId || !dbClient) return []
  const rows = await applyRecordFilters(dbClient('records'), { userId, hints })
    .select('category')
    .select(dbClient.raw('SUM(COALESCE(amount_cny, amount)) as total'))
    .select(dbClient.raw('COUNT(*) as count'))
    .groupBy('category')
    .orderBy('total', 'desc')
  return rows.map(row => ({
    category: row.category || '其他',
    total: Number(row.total || 0),
    count: Number(row.count || 0)
  }))
}
