import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFinanceQueryReply,
  queryFinanceSummary
} from '../src/services/financeQuery.js'

function createRecordsDb(rows) {
  return function db(tableName) {
    assert.equal(tableName, 'records')
    const state = { rows: [...rows], limit: null }
    const api = {
      where(field, value) {
        state.rows = state.rows.filter(row => row[field] === value)
        return api
      },
      whereRaw(sql, bindings) {
        if (sql.includes('DATE_FORMAT')) {
          state.rows = state.rows.filter(row => String(row.date).slice(0, 7) === bindings[0])
        }
        return api
      },
      orderBy(field, direction) {
        const key = field.includes('amount') ? 'amount_cny' : field.replace('r.', '')
        state.rows.sort((a, b) => {
          const av = a[key] ?? a.amount
          const bv = b[key] ?? b.amount
          if (av === bv) return 0
          return direction === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
        })
        return api
      },
      limit(value) {
        state.limit = value
        return api
      },
      async select() {
        const rowsToReturn = state.limit ? state.rows.slice(0, state.limit) : state.rows
        return rowsToReturn.map(row => ({
          ...row,
          amount_cny: row.amount_cny ?? row.amount
        }))
      }
    }
    return api
  }
}

test('queryFinanceSummary filters by user month category and type', async () => {
  const db = createRecordsDb([
    { id: 1, user_id: 7, type: 'expense', category: '餐饮', amount: 20, amount_cny: 20, date: '2026-07-18', description: '午饭' },
    { id: 2, user_id: 7, type: 'expense', category: '餐饮', amount: 30, amount_cny: 30, date: '2026-07-17', description: '晚饭' },
    { id: 3, user_id: 7, type: 'expense', category: '购物', amount: 99, amount_cny: 99, date: '2026-07-16', description: '衣服' },
    { id: 4, user_id: 8, type: 'expense', category: '餐饮', amount: 500, amount_cny: 500, date: '2026-07-18', description: '别人' }
  ])

  const summary = await queryFinanceSummary({
    userId: 7,
    hints: { month: '2026-07', category: '餐饮', type: 'expense', queryKind: 'summary' },
    db
  })

  assert.equal(summary.count, 2)
  assert.equal(summary.total, 50)
  assert.equal(summary.maxRecord.amount, 30)
  assert.equal(summary.records.length, 2)
})

test('queryFinanceSummary supports recent and largest query kinds', async () => {
  const db = createRecordsDb([
    { id: 1, user_id: 7, type: 'expense', category: '餐饮', amount: 20, date: '2026-07-18', description: '午饭' },
    { id: 2, user_id: 7, type: 'expense', category: '餐饮', amount: 88, date: '2026-07-10', description: '聚餐' }
  ])

  const recent = await queryFinanceSummary({ userId: 7, hints: { queryKind: 'recent' }, db })
  const largest = await queryFinanceSummary({ userId: 7, hints: { queryKind: 'largest' }, db })

  assert.equal(recent.records[0].id, 1)
  assert.equal(largest.maxRecord.id, 2)
})

test('queryFinanceSummary totals all matching rows beyond display limit', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({
    id: index + 1,
    user_id: 7,
    type: 'expense',
    category: '餐饮',
    amount: 1,
    amount_cny: 1,
    date: '2026-07-18',
    description: `第${index + 1}笔`
  }))
  const db = createRecordsDb(rows)

  const summary = await queryFinanceSummary({
    userId: 7,
    hints: { month: '2026-07', category: '餐饮', type: 'expense', queryKind: 'summary' },
    db,
    limit: 5
  })

  assert.equal(summary.count, 201)
  assert.equal(summary.total, 201)
  assert.equal(summary.records.length, 5)
})

test('buildFinanceQueryReply creates summary recent largest and empty replies', () => {
  const summary = {
    hints: { month: '2026-07', category: '餐饮', type: 'expense', queryKind: 'summary' },
    count: 2,
    total: 50,
    average: 25,
    maxRecord: { amount: 30, date: '2026-07-17', description: '晚饭' },
    records: []
  }

  assert.match(buildFinanceQueryReply(summary), /2026-07 餐饮支出共 50\.00 元/)
  assert.match(buildFinanceQueryReply({ ...summary, hints: { ...summary.hints, queryKind: 'largest' } }), /最大一笔/)
  assert.match(buildFinanceQueryReply({
    ...summary,
    hints: { ...summary.hints, queryKind: 'recent' },
    records: [{ amount: 20, date: '2026-07-18', description: '午饭' }]
  }), /最近找到 1 笔/)
  assert.match(buildFinanceQueryReply({ ...summary, count: 0, total: 0, maxRecord: null }), /没找到/)
})
