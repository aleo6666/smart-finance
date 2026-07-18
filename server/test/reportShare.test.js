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

function createFakeDb(reportOwner, shareInserts) {
  return function dbClient(table) {
    const where = {}
    return {
      where(values) {
        Object.assign(where, values)
        return this
      },
      async first() {
        if (table !== 'reports') return undefined
        if (where.id === 10 && where.user_id === reportOwner) {
          return { id: 10, user_id: reportOwner }
        }
        return undefined
      },
      async insert(values) {
        if (table === 'report_shares') shareInserts.push(values)
        return [1]
      }
    }
  }
}

function appWithReportOwner(reportOwner, shareInserts) {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', createReportsRouter({
    dbClient: createFakeDb(reportOwner, shareInserts),
    createToken: () => 'share-token'
  }))
  return app
}

test('POST /api/reports/share/:id rejects a report owned by another user', async () => {
  const shareInserts = []
  const { server, url } = await listen(appWithReportOwner(8, shareInserts))
  try {
    const response = await fetch(`${url}/api/reports/share/10`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(7)}` }
    })

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { success: false, error: '报表不存在' })
    assert.equal(shareInserts.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/reports/share/:id creates a share for the report owner', async () => {
  const shareInserts = []
  const { server, url } = await listen(appWithReportOwner(7, shareInserts))
  try {
    const response = await fetch(`${url}/api/reports/share/10`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(7)}` }
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.match(json.data.url, /\/api\/share\/share-token$/)
    assert.equal(shareInserts.length, 1)
    assert.equal(shareInserts[0].report_id, 10)
    assert.equal(shareInserts[0].token, 'share-token')
    assert.match(shareInserts[0].expire_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  } finally {
    server.close()
  }
})
