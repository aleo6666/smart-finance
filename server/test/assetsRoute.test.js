import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createAssetsRouter } from '../src/routes/assets.js'
import { signToken } from '../src/middleware/auth.js'
import { getCreateTableStatements } from '../src/schema.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function dateString(offsetDays) {
  return toDateString(addDays(new Date(), offsetDays))
}

function createFakeDb({ assets = [], snapshots = [] } = {}) {
  const data = { assets: [...assets], daily_balance_snapshots: [...snapshots] }
  const state = { tables: [], inserts: [], updates: [], deletes: [] }

  function matches(row, where, predicates) {
    const objectOk = Object.entries(where).every(([key, value]) => row[key] == value)
    if (!objectOk) return false
    return predicates.every(({ key, op, value }) => {
      if (op === '>=') return row[key] >= value
      if (op === '<=') return row[key] <= value
      if (op === '>') return row[key] > value
      if (op === '<') return row[key] < value
      return row[key] === value
    })
  }

  function sortRows(rows, sort) {
    const direction = sort.direction === 'desc' ? -1 : 1
    return [...rows].sort((a, b) => {
      if (a[sort.column] == null) return 1
      if (b[sort.column] == null) return -1
      return String(a[sort.column]).localeCompare(String(b[sort.column])) * direction
    })
  }

  function db(table) {
    state.tables.push(table)
    const where = {}
    const predicates = []
    let sort = null
    let selectCols = null
    let sumAlias = null
    let sumColumn = null
    let groupColumn = null
    let limitCount = null
    const getRows = () => data[table]

    const query = {
      where(input, op, value) {
        if (typeof input === 'string' && value !== undefined) {
          predicates.push({ key: input, op, value })
        } else if (typeof input === 'string') {
          predicates.push({ key: input, op: '=', value: op })
        } else {
          Object.assign(where, input)
        }
        return query
      },
      orderBy(column, direction = 'asc') {
        sort = { column, direction }
        return query
      },
      select(...cols) {
        selectCols = cols.flat()
        return query
      },
      sum(obj) {
        sumAlias = Object.keys(obj)[0]
        sumColumn = obj[sumAlias]
        return query
      },
      groupBy(column) {
        groupColumn = column
        return query
      },
      limit(value) {
        limitCount = value
        return query
      },
      async first() {
        let rows = getRows().filter(row => matches(row, where, predicates))
        if (sort) rows = sortRows(rows, sort)
        return rows[0]
      },
      async update(values) {
        let count = 0
        for (const row of getRows()) {
          if (matches(row, where, predicates)) {
            Object.assign(row, values)
            count++
          }
        }
        state.updates.push(values)
        return count
      },
      async delete() {
        const remaining = getRows().filter(row => !matches(row, where, predicates))
        const count = getRows().length - remaining.length
        data[table] = remaining
        state.deletes.push(count)
        return count
      },
      insert(values) {
        const id = getRows().length ? Math.max(...getRows().map(row => Number(row.id))) + 1 : 1
        const row = { id, ...values }
        return {
          onConflict() {
            return {
              merge: async (updates) => {
                const existing = getRows().find(candidate =>
                  candidate.user_id == values.user_id && candidate.snapshot_date == values.snapshot_date
                )
                if (existing) Object.assign(existing, updates)
                else data[table].push(row)
              }
            }
          },
          then(resolve, reject) {
            state.inserts.push(values)
            data[table].push(row)
            return Promise.resolve([row.id]).then(resolve, reject)
          }
        }
      },
      then(resolve, reject) {
        let rows = getRows().filter(row => matches(row, where, predicates))
        if (sort) rows = sortRows(rows, sort)
        if (limitCount != null) rows = rows.slice(0, limitCount)
        if (sumAlias && groupColumn) {
          const totals = new Map()
          for (const row of rows) {
            const key = row[groupColumn]
            totals.set(key, (totals.get(key) || 0) + Number(row[sumColumn] || 0))
          }
          rows = [...totals.entries()].map(([key, total]) => ({ [groupColumn]: key, [sumAlias]: total }))
        } else if (selectCols && selectCols.length) {
          rows = rows.map(row => Object.fromEntries(selectCols.map(col => [col, row[col]])))
        }
        return Promise.resolve(rows).then(resolve, reject)
      }
    }
    return query
  }

  db.state = state
  db.data = data
  return db
}

function createApp(dbClient) {
  const app = express()
  app.use(express.json())
  app.use('/api/assets', createAssetsRouter({ dbClient }))
  return app
}

test('schema defines assets and daily_balance_snapshots tables', () => {
  const sql = getCreateTableStatements().join('\n')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS assets/)
  assert.match(sql, /type\s+ENUM\('deposit','fund','stock','liability'\)/)
  assert.match(sql, /balance\s+DECIMAL\(14,4\)/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS daily_balance_snapshots/)
  assert.match(sql, /UNIQUE KEY uniq_daily_balance_snapshot \(user_id, snapshot_date\)/)
})

async function request(url, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
}

test('GET /api/assets requires authentication', async () => {
  const app = createApp(createFakeDb())
  const { server, url } = await listen(app)
  try {
    const response = await request(`${url}/api/assets`)
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})

test('GET /api/assets returns accounts grouped by type for the current user', async () => {
  const db = createFakeDb({
    assets: [
      { id: 1, user_id: 7, name: '招行卡', type: 'deposit', balance: 1000, currency: 'CNY', note: null, created_at: '2026-08-01T00:00:00.000Z' },
      { id: 2, user_id: 7, name: '指数基金', type: 'fund', balance: 2000, currency: 'CNY', note: null, created_at: '2026-08-02T00:00:00.000Z' },
      { id: 3, user_id: 7, name: '房贷', type: 'liability', balance: 800, currency: 'CNY', note: null, created_at: '2026-08-03T00:00:00.000Z' },
      { id: 4, user_id: 8, name: '他人股票', type: 'stock', balance: 500, currency: 'CNY', note: null, created_at: '2026-08-04T00:00:00.000Z' }
    ]
  })
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const response = await request(`${url}/api/assets`, { token: signToken(7) })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(json.data), ['deposit', 'fund', 'stock', 'liability'])
    assert.equal(json.data.deposit.length, 1)
    assert.equal(json.data.deposit[0].name, '招行卡')
    assert.equal(json.data.fund.length, 1)
    assert.equal(json.data.liability.length, 1)
    assert.deepEqual(json.data.stock, [])
  } finally {
    server.close()
  }
})

test('POST /api/assets creates an account scoped to the current user with default currency', async () => {
  const db = createFakeDb()
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const response = await request(`${url}/api/assets`, {
      method: 'POST',
      token: signToken(7),
      body: { name: '现金账户', type: 'deposit', balance: 1234.56, note: '备用金' }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.id, 1)
    assert.equal(json.data.user_id, 7)
    assert.equal(json.data.name, '现金账户')
    assert.equal(json.data.currency, 'CNY')
    assert.equal(json.data.note, '备用金')
    assert.equal(db.state.inserts[0].user_id, 7)
    assert.equal(db.state.inserts[0].type, 'deposit')
    assert.equal(db.state.inserts[0].balance, 1234.56)
  } finally {
    server.close()
  }
})

test('POST /api/assets rejects invalid type, non-numeric balance and missing name', async () => {
  const app = createApp(createFakeDb())
  const { server, url } = await listen(app)
  try {
    const invalidType = await request(`${url}/api/assets`, {
      method: 'POST',
      token: signToken(7),
      body: { name: '账户', type: 'cash', balance: 100 }
    })
    assert.equal(invalidType.status, 400)

    const invalidBalance = await request(`${url}/api/assets`, {
      method: 'POST',
      token: signToken(7),
      body: { name: '账户', type: 'deposit', balance: 'abc' }
    })
    assert.equal(invalidBalance.status, 400)

    const negativeBalance = await request(`${url}/api/assets`, {
      method: 'POST',
      token: signToken(7),
      body: { name: '账户', type: 'deposit', balance: -1 }
    })
    assert.equal(negativeBalance.status, 400)

    const missingName = await request(`${url}/api/assets`, {
      method: 'POST',
      token: signToken(7),
      body: { type: 'deposit', balance: 100 }
    })
    assert.equal(missingName.status, 400)
  } finally {
    server.close()
  }
})

test('PUT /api/assets/:id updates name, balance and note', async () => {
  const db = createFakeDb({
    assets: [
      { id: 9, user_id: 7, name: '旧名', type: 'deposit', balance: 100, currency: 'CNY', note: null, created_at: '2026-08-01T00:00:00.000Z' }
    ]
  })
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const response = await request(`${url}/api/assets/9`, {
      method: 'PUT',
      token: signToken(7),
      body: { name: '新名', balance: 250.5, note: '已更新' }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data.name, '新名')
    assert.equal(json.data.balance, 250.5)
    assert.equal(json.data.note, '已更新')
    assert.deepEqual(db.state.updates.at(-1), { name: '新名', balance: 250.5, note: '已更新' })
  } finally {
    server.close()
  }
})

test('PUT /api/assets/:id returns 404 for another user account and rejects invalid balance', async () => {
  const db = createFakeDb({
    assets: [
      { id: 9, user_id: 8, name: '别人的账户', type: 'deposit', balance: 100, currency: 'CNY', note: null, created_at: '2026-08-01T00:00:00.000Z' }
    ]
  })
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const notFound = await request(`${url}/api/assets/9`, {
      method: 'PUT',
      token: signToken(7),
      body: { balance: 300 }
    })
    assert.equal(notFound.status, 404)

    const invalid = await request(`${url}/api/assets/999`, {
      method: 'PUT',
      token: signToken(7),
      body: { balance: -5 }
    })
    assert.equal(invalid.status, 404)
  } finally {
    server.close()
  }
})

test('DELETE /api/assets/:id removes the account and 404s for missing ones', async () => {
  const db = createFakeDb({
    assets: [
      { id: 5, user_id: 7, name: '待删除', type: 'fund', balance: 100, currency: 'CNY', note: null, created_at: '2026-08-01T00:00:00.000Z' }
    ]
  })
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const deleted = await request(`${url}/api/assets/5`, { method: 'DELETE', token: signToken(7) })
    const deletedJson = await deleted.json()
    assert.equal(deleted.status, 200)
    assert.equal(deletedJson.success, true)
    assert.equal(db.data.assets.length, 0)
    assert.deepEqual(db.state.deletes, [1])

    const missing = await request(`${url}/api/assets/5`, { method: 'DELETE', token: signToken(7) })
    assert.equal(missing.status, 404)

    const otherUser = await request(`${url}/api/assets/1`, { method: 'DELETE', token: signToken(7) })
    assert.equal(otherUser.status, 404)
  } finally {
    server.close()
  }
})

test('GET /api/assets/overview computes total assets, liabilities, net worth and type breakdown', async () => {
  const db = createFakeDb({
    assets: [
      { id: 1, user_id: 7, name: '存款', type: 'deposit', balance: 1000.5, currency: 'CNY', note: null, created_at: '2026-08-01T00:00:00.000Z' },
      { id: 2, user_id: 7, name: '基金', type: 'fund', balance: 2000, currency: 'CNY', note: null, created_at: '2026-08-02T00:00:00.000Z' },
      { id: 3, user_id: 7, name: '股票', type: 'stock', balance: 500.25, currency: 'CNY', note: null, created_at: '2026-08-03T00:00:00.000Z' },
      { id: 4, user_id: 7, name: '房贷', type: 'liability', balance: 800, currency: 'CNY', note: null, created_at: '2026-08-04T00:00:00.000Z' },
      { id: 5, user_id: 8, name: '他人资产', type: 'deposit', balance: 99999, currency: 'CNY', note: null, created_at: '2026-08-05T00:00:00.000Z' }
    ]
  })
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const response = await request(`${url}/api/assets/overview`, { token: signToken(7) })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(json.data.summary, {
      total_assets: 3500.75,
      total_liabilities: 800,
      net_worth: 2700.75
    })
    assert.deepEqual(json.data.breakdown, [
      { type: 'deposit', total: 1000.5, percent: 28.58 },
      { type: 'fund', total: 2000, percent: 57.13 },
      { type: 'stock', total: 500.25, percent: 14.29 },
      { type: 'liability', total: 800, percent: 22.85 }
    ])
  } finally {
    server.close()
  }
})

test('GET /api/assets/overview returns a 30-day net worth curve and upserts today snapshot', async () => {
  const threeDaysAgo = dateString(-3)
  const twoDaysAgo = dateString(-2)
  const oneDayAgo = dateString(-1)
  const today = dateString(0)
  const db = createFakeDb({
    assets: [
      { id: 1, user_id: 7, name: '存款', type: 'deposit', balance: 3000, currency: 'CNY', note: null, created_at: '2026-08-01T00:00:00.000Z' }
    ],
    snapshots: [
      { id: 1, user_id: 7, snapshot_date: threeDaysAgo, total_assets: 1000, total_liabilities: 0, net_worth: 1000 },
      { id: 2, user_id: 7, snapshot_date: oneDayAgo, total_assets: 2000, total_liabilities: 300, net_worth: 1700 }
    ]
  })
  const app = createApp(db)
  const { server, url } = await listen(app)
  try {
    const response = await request(`${url}/api/assets/overview`, { token: signToken(7) })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data.curve.length, 30)
    assert.equal(json.data.curve[0].date, dateString(-29))
    assert.deepEqual(json.data.curve[0], { date: dateString(-29), total_assets: 0, total_liabilities: 0, net_worth: 0 })

    const byDate = new Map(json.data.curve.map(point => [point.date, point]))
    assert.equal(byDate.get(threeDaysAgo).net_worth, 1000)
    assert.equal(byDate.get(twoDaysAgo).net_worth, 1000)
    assert.equal(byDate.get(oneDayAgo).net_worth, 1700)
    assert.equal(byDate.get(today).net_worth, 3000)
    assert.equal(byDate.get(today).total_assets, 3000)

    const todayRows = db.data.daily_balance_snapshots.filter(row => row.snapshot_date === today && row.user_id === 7)
    assert.equal(todayRows.length, 1)
  } finally {
    server.close()
  }
})
