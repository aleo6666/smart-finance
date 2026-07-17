import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createObserveRouter } from '../src/routes/observe.js'
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

test('GET /api/observe/stats uses authenticated user and period query', async () => {
  const calls = []
  const app = express()
  app.use('/api/observe', createObserveRouter({
    getObserveStats: async input => {
      calls.push(input)
      return { summary: { calls: 1 }, period: { key: input.period, days: 7 } }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/observe/stats?period=7d&userId=999`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(calls[0].userId, 7)
    assert.equal(calls[0].period, '7d')
    assert.equal(json.data.summary.calls, 1)
  } finally {
    server.close()
  }
})

test('GET /api/observe/stats requires auth', async () => {
  const app = express()
  app.use('/api/observe', createObserveRouter({
    getObserveStats: async () => ({ summary: { calls: 0 } })
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/observe/stats`)
    const json = await response.json()
    assert.equal(response.status, 401)
    assert.equal(json.success, false)
  } finally {
    server.close()
  }
})
