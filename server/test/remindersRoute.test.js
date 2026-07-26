import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createRemindersRouter } from '../src/routes/reminders.js'
import { signToken } from '../src/middleware/auth.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function createQuery(rows) {
  const state = { table: '', where: {}, limit: null, updates: null }
  const query = {
    where(input, value) {
      if (typeof input === 'string') state.where[input] = value
      else Object.assign(state.where, input)
      return query
    },
    orderBy() { return query },
    limit(value) {
      state.limit = value
      return query
    },
    async update(values) {
      state.updates = values
      return 1
    },
    async first() {
      if (state.count) {
        return {
          count: rows.filter(row => row.user_id === state.where.user_id && row.status === state.where.status).length
        }
      }
      return rows[0]
    },
    count() {
      state.count = true
      return query
    },
    then(resolve, reject) {
      const result = rows
        .filter(row => state.where.user_id == null || row.user_id === state.where.user_id)
        .filter(row => state.where.status == null || row.status === state.where.status)
        .slice(0, state.limit || rows.length)
      return Promise.resolve(result).then(resolve, reject)
    },
    state
  }
  return query
}

function createFakeDb(reminderRows, states = []) {
  function db(table) {
    const rows = table === 'reminders' ? reminderRows : []
    const query = createQuery(rows)
    query.state.table = table
    states.push(query.state)
    return query
  }
  db.fn = { now: () => 'NOW' }
  return db
}

test('GET /api/reminders uses the injected database for backfill and display data', async () => {
  const states = []
  const rows = [{
    id: 1,
    user_id: 7,
    type: 'budget_alert',
    title: '预算提醒',
    message: JSON.stringify({ month: '2026-07', category: '餐饮', level: 'warn', percent: 86, budget: 1000, spent: 860 }),
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  }]
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createFakeDb(rows, states) }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data[0].display.kind, 'budget')
    assert.equal(json.data[0].display.summary, '餐饮预算已使用 86%')
    assert.deepEqual(states.map(state => state.table), ['budgets', 'reminders'])
  } finally {
    server.close()
  }
})

test('GET /api/reminders/highlights returns priority limited reminders', async () => {
  const rows = [
    { id: 1, user_id: 7, type: 'daily', title: '普通', message: '普通', status: 'pending', created_at: '2026-07-18T12:00:00.000Z' },
    { id: 2, user_id: 7, type: 'budget_alert', title: 'warn', message: JSON.stringify({ level: 'warn', category: '餐饮', month: '2026-07', percent: 81, budget: 100, spent: 81 }), status: 'pending', created_at: '2026-07-18T09:00:00.000Z' },
    { id: 3, user_id: 7, type: 'budget_alert', title: 'critical', message: JSON.stringify({ level: 'critical', category: '交通', month: '2026-07', percent: 101, budget: 100, spent: 101 }), status: 'pending', created_at: '2026-07-18T08:00:00.000Z' }
  ]
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createFakeDb(rows) }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders/highlights?limit=2`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.deepEqual(json.data.map(item => item.id), [3, 2])
  } finally {
    server.close()
  }
})

test('PUT /api/reminders/:id/read scopes update to current user', async () => {
  const states = []
  const app = express()
  app.use(express.json())
  app.use('/api/reminders', createRemindersRouter({ dbClient: createFakeDb([], states) }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reminders/9/read`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.deepEqual(states.at(-1).where, { id: '9', user_id: 7 })
  } finally {
    server.close()
  }
})
