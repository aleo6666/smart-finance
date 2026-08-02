import { queryFinanceSummary as sharedQueryFinanceSummary } from './recordQuery.js'
import db from '../db.js'

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

/**
 * 查询财务汇总（委托给 recordQuery 公共模块）
 * @deprecated 请直接使用 services/recordQuery.js 中的 queryFinanceSummary
 */
export async function queryFinanceSummary({
  userId,
  hints = {},
  db: dbClient = db,
  limit = 5
} = {}) {
  return sharedQueryFinanceSummary({ userId, hints, dbClient, limit })
}

export function buildFinanceQueryReply(summary) {
  const label = scopeText(summary.hints)
  if (!summary.count) return `没找到${label}记录。你可以先记一笔，例如"今天餐饮花了25元"。`

  if (summary.hints?.queryKind === 'recent') {
    const details = summary.records.map(record =>
      `${record.date} ${Number(record.amount).toFixed(2)} 元${record.description ? `（${record.description}）` : ''}`
    ).join('，')
    return `最近找到 ${summary.records.length} 笔${label}记录：${details}。`
  }

  if (summary.hints?.queryKind === 'largest') {
    const record = summary.maxRecord
    return `${label}最大一笔是 ${Number(record.amount).toFixed(2)} 元，记录在 ${record.date}${record.description ? `（${record.description}）` : ''}。`
  }

  const maxText = summary.maxRecord
    ? `，最大一笔是 ${Number(summary.maxRecord.amount).toFixed(2)} 元`
    : ''
  return `${label}共 ${summary.total.toFixed(2)} 元，合计 ${summary.count} 笔，平均每笔 ${summary.average.toFixed(2)} 元${maxText}。`
}
