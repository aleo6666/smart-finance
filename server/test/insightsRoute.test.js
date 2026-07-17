import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createInsightsRouter } from '../src/routes/insights.js'
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

function createFakeDb(rows = []) {
  function db(table) {
    assert.equal(table, 'feedback')
    return {
      async insert(value) {
        rows.push({ id: rows.length + 1, ...value })
        return [rows.length]
      },
      where(condition) {
        return {
          first: async () => rows.find(row => Object.entries(condition).every(([key, value]) => row[key] == value))
        }
      }
    }
  }
  db.rows = rows
  return db
}

test('POST /api/insights/feedback writes inaccurate feedback as P1 for current user', async () => {
  const db = createFakeDb()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.deviceId = 'device-1'; next() })
  app.use('/api/insights', createInsightsRouter({ dbClient: db }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        insightId: 'food-risk',
        reportId: 12,
        isAccurate: false,
        correction: '这是一次性聚餐',
        context: { summary: '餐饮上升' }
      })
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.priority, 'P1')
    assert.equal(db.rows[0].user_id, 7)
    assert.equal(db.rows[0].device_id, 'device-1')
    assert.equal(db.rows[0].type, 'ai_insight')
    assert.equal(JSON.parse(db.rows[0].content).insightId, 'food-risk')
  } finally {
    server.close()
  }
})

test('POST /api/insights/feedback writes accurate feedback as P2', async () => {
  const db = createFakeDb()
  const app = express()
  app.use(express.json())
  app.use('/api/insights', createInsightsRouter({ dbClient: db }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ insightId: 'saving-good', isAccurate: true })
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.data.priority, 'P2')
  } finally {
    server.close()
  }
})

test('POST /api/insights/feedback validates auth and required fields', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/insights', createInsightsRouter({ dbClient: createFakeDb() }))

  const { server, url } = await listen(app)
  try {
    const noAuth = await fetch(`${url}/api/insights/feedback`, { method: 'POST' })
    assert.equal(noAuth.status, 401)

    const missing = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAccurate: false })
    })
    assert.equal(missing.status, 400)

    const invalid = await fetch(`${url}/api/insights/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ insightId: 'x', isAccurate: 'no' })
    })
    assert.equal(invalid.status, 400)
  } finally {
    server.close()
  }
})
