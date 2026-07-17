import test from 'node:test'
import assert from 'node:assert/strict'
import { checkObserveAlerts } from '../src/services/alertService.js'

function createQuery(table, tables) {
  const state = { where: [], whereNull: [], order: null, limit: null }
  const query = {
    where(condition) {
      state.where.push(condition)
      return query
    },
    whereNull(column) {
      state.whereNull.push(column)
      return query
    },
    orderBy(column, direction = 'asc') {
      state.order = { column, direction }
      return query
    },
    limit(value) {
      state.limit = value
      return query
    },
    async insert(value) {
      tables[table].push({ id: tables[table].length + 1, ...value })
      return [tables[table].length]
    },
    async first() {
      return apply()[0]
    },
    sum() {
      return {
        first: async () => ({
          total: apply().reduce((sum, row) => sum + Number(row.cost_usd || 0), 0)
        })
      }
    },
    then(resolve, reject) {
      return Promise.resolve(apply()).then(resolve, reject)
    }
  }

  function apply() {
    let rows = [...tables[table]]
    for (const condition of state.where) {
      rows = rows.filter(row => Object.entries(condition).every(([key, value]) => row[key] === value))
    }
    for (const column of state.whereNull) {
      rows = rows.filter(row => row[column] == null)
    }
    if (state.order) {
      rows.sort((a, b) => {
        const left = a[state.order.column]
        const right = b[state.order.column]
        if (left === right) return 0
        return state.order.direction === 'desc' ? (left > right ? -1 : 1) : (left > right ? 1 : -1)
      })
    }
    if (state.limit) rows = rows.slice(0, state.limit)
    return rows
  }

  return query
}

function createFakeDb(seed = {}) {
  const tables = {
    llm_calls: [...(seed.llm_calls || [])],
    reminders: [...(seed.reminders || [])],
    cost_alert_rules: [...(seed.cost_alert_rules || [])]
  }

  function db(table) {
    return createQuery(table, tables)
  }

  db.tables = tables
  db.fn = { now: () => 'NOW' }
  return db
}

test('checkObserveAlerts creates cost spike reminder for expensive single call', async () => {
  const db = createFakeDb()

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0.6, success: true },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(result.created.map(item => item.type), ['alert:cost_spike'])
  assert.equal(db.tables.reminders[0].user_id, 7)
  assert.equal(db.tables.reminders[0].type, 'alert:cost_spike')
  assert.equal(db.tables.reminders[0].status, 'pending')
})

test('checkObserveAlerts creates threshold reminder from user cost rule', async () => {
  const db = createFakeDb({
    llm_calls: [
      { user_id: 7, cost_usd: 0.7, success: 1, created_at: '2026-07-18 09:00:00' },
      { user_id: 7, cost_usd: 0.5, success: 1, created_at: '2026-07-18 08:00:00' }
    ],
    cost_alert_rules: [
      { user_id: 7, threshold_usd: 1, period_days: 1, enabled: 1 }
    ]
  })

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0.1, success: true },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.equal(result.created.some(item => item.type === 'alert:cost_threshold'), true)
  assert.equal(db.tables.reminders.at(-1).type, 'alert:cost_threshold')
})

test('checkObserveAlerts creates failures reminder after three recent failures', async () => {
  const db = createFakeDb({
    llm_calls: [
      { user_id: 7, cost_usd: 0, success: 0, created_at: '2026-07-18 09:03:00' },
      { user_id: 7, cost_usd: 0, success: 0, created_at: '2026-07-18 09:02:00' },
      { user_id: 7, cost_usd: 0, success: 0, created_at: '2026-07-18 09:01:00' },
      { user_id: 7, cost_usd: 0, success: 1, created_at: '2026-07-18 08:00:00' }
    ]
  })

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0, success: false },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(result.created.map(item => item.type), ['alert:llm_failures'])
})

test('checkObserveAlerts deduplicates same alert type during same day', async () => {
  const db = createFakeDb({
    reminders: [
      { user_id: 7, type: 'alert:cost_spike', status: 'pending', created_at: '2026-07-18 08:00:00' }
    ]
  })

  const result = await checkObserveAlerts({
    userId: 7,
    lastCall: { costUsd: 0.7, success: true },
    now: new Date('2026-07-18T10:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(result.created, [])
  assert.equal(db.tables.reminders.length, 1)
})
