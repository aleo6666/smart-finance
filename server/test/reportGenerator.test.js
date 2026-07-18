import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, periodRange } from '../src/services/reportGenerator.js'

function createReportDb(rows) {
  function db(tableName) {
    assert.equal(tableName, 'records as r')
    const state = { rows: [...rows], limit: null, offset: 0, groupBy: null }
    const api = {
      where(field, value) {
        const key = field.replace('r.', '')
        state.rows = state.rows.filter(row => row[key] === value)
        return api
      },
      whereRaw(sql, bindings) {
        if (sql.includes('r.date >= ?') && sql.includes('r.date <= ?')) {
          state.rows = state.rows.filter(row => row.date >= bindings[0] && row.date <= bindings[1])
        }
        if (sql.includes('r.merchant LIKE')) {
          const keyword = bindings[0].replaceAll('%', '')
          state.rows = state.rows.filter(row => String(row.merchant || '').includes(keyword))
        }
        return api
      },
      select(...columns) {
        if (columns.includes('r.category')) state.groupBy = 'category'
        if (columns.includes('r.currency')) state.groupBy = 'currency'
        if (columns.includes('r.type')) state.groupBy = 'type'
        return api
      },
      sum() { return api },
      count() { return api },
      groupBy(field) {
        state.groupBy = field.replace('r.', '')
        return api
      },
      orderBy() { return api },
      limit(value) {
        state.limit = value
        return api
      },
      offset(value) {
        state.offset = value
        return api
      },
      then(resolve, reject) {
        try {
          resolve(materialize())
        } catch (error) {
          reject(error)
        }
      }
    }

    function amountOf(row) {
      return Number(row.amount_cny ?? row.amount ?? 0)
    }

    function materialize() {
      if (state.groupBy === 'type') {
        return ['income', 'expense'].map(type => {
          const scoped = state.rows.filter(row => row.type === type)
          return { type, total: scoped.reduce((sum, row) => sum + amountOf(row), 0), count: scoped.length }
        }).filter(row => row.count)
      }
      if (state.groupBy === 'category') {
        const map = new Map()
        for (const row of state.rows.filter(item => item.type === 'expense')) {
          const current = map.get(row.category) || { category: row.category, total: 0, count: 0 }
          current.total += amountOf(row)
          current.count += 1
          map.set(row.category, current)
        }
        return [...map.values()].sort((a, b) => b.total - a.total)
      }
      if (state.groupBy === 'currency') {
        const map = new Map()
        for (const row of state.rows) {
          const current = map.get(row.currency) || { currency: row.currency, total: 0 }
          current.total += Number(row.amount || 0)
          map.set(row.currency, current)
        }
        return [...map.values()]
      }
      return state.rows.slice(state.offset, state.limit ? state.offset + state.limit : undefined).map(row => ({
        ...row,
        amount_cny: amountOf(row)
      }))
    }

    return api
  }

  db.raw = sql => sql
  return db
}

test('periodRange supports month quarter year and week', () => {
  assert.deepEqual(periodRange('month', '2026-07'), { start: '2026-07-01', end: '2026-07-31' })
  assert.deepEqual(periodRange('quarter', '2026-Q2'), { start: '2026-04-01', end: '2026-06-30' })
  assert.deepEqual(periodRange('year', '2026'), { start: '2026-01-01', end: '2026-12-31' })
  assert.deepEqual(periodRange('week', '2026-07-13'), { start: '2026-07-13', end: '2026-07-19' })
})

test('buildReport aggregates records by user period category and returns limited details', async () => {
  const db = createReportDb([
    { id: 1, user_id: 7, type: 'income', category: '工资', amount: 500, amount_cny: 500, currency: 'CNY', date: '2026-07-01' },
    { id: 2, user_id: 7, type: 'expense', category: '餐饮', amount: 20, amount_cny: 20, currency: 'CNY', date: '2026-07-18', description: '午饭' },
    { id: 3, user_id: 7, type: 'expense', category: '购物', amount: 80, amount_cny: 80, currency: 'CNY', date: '2026-07-17' },
    { id: 4, user_id: 8, type: 'expense', category: '餐饮', amount: 999, amount_cny: 999, currency: 'CNY', date: '2026-07-18' }
  ])

  const report = await buildReport({
    userId: 7,
    periodType: 'month',
    periodValue: '2026-07',
    filters: { limit: 2 },
    db
  })

  assert.equal(report.income, 500)
  assert.equal(report.expense, 100)
  assert.equal(report.balance, 400)
  assert.equal(report.count, 2)
  assert.deepEqual(report.byCategory.map(item => item.category), ['购物', '餐饮'])
  assert.equal(report.records.length, 2)
})
