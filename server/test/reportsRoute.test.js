import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import jwt from 'jsonwebtoken'
import config from '../src/config.js'
import { createReportsRouter } from '../src/routes/reports.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function token(userId = 7) {
  return jwt.sign({ userId }, config.auth.jwtSecret)
}

function createMonthlyDb(calls) {
  const dbClient = table => {
    assert.equal(table, 'records')
    return {
      where(...args) {
        calls.push(['where', ...args])
        return this
      },
      whereRaw(...args) {
        calls.push(['whereRaw', ...args])
        return this
      },
      select(...args) {
        calls.push(['select', ...args])
        return this
      },
      sum(...args) {
        calls.push(['sum', ...args])
        return this
      },
      count(...args) {
        calls.push(['count', ...args])
        return this
      },
      groupBy(...args) {
        calls.push(['groupBy', ...args])
        return Promise.resolve([
          { type: 'expense', total: 25, count: 1 }
        ])
      }
    }
  }
  dbClient.raw = sql => sql
  return dbClient
}

test('GET /api/reports/monthly scopes results to the selected ledger', async () => {
  const calls = []
  const app = express()
  app.use('/api/reports', createReportsRouter({ dbClient: createMonthlyDb(calls) }))
  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/reports/monthly?month=2026-07&ledgerId=42`, {
      headers: { Authorization: `Bearer ${token(7)}` }
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.deepEqual(calls.filter(call => call[0] === 'where'), [
      ['where', 'user_id', 7],
      ['where', 'ledger_id', 42]
    ])
  } finally {
    server.close()
  }
})
