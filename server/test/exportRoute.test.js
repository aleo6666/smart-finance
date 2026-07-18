import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createServer } from 'http'
import config from '../src/config.js'
import { createExportRouter } from '../src/routes/export.js'

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

function appWithRouter(buildReportCalls = [], { now } = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/export', createExportRouter({
    buildReport: async params => {
      buildReportCalls.push(params)
      return { income: 100, expense: 50, balance: 50, byCategory: [], records: [] }
    },
    buildExcelBuffer: async () => Buffer.from('excel'),
    buildPdfBuffer: async () => Buffer.from('%PDF-test'),
    buildImageBuffer: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    now
  }))
  return app
}

test('GET /api/export/excel requires auth', async () => {
  const { server, url } = await listen(appWithRouter())
  try {
    const response = await fetch(`${url}/api/export/excel`)
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})

test('GET /api/export/excel uses default period and empty filters', async () => {
  const buildReportCalls = []
  const now = () => new Date(2026, 6, 18, 12, 0)
  const { server, url } = await listen(appWithRouter(buildReportCalls, { now }))
  try {
    const response = await fetch(`${url}/api/export/excel`, {
      headers: { Authorization: `Bearer ${token()}` }
    })
    assert.equal(response.status, 200)
    assert.deepEqual(buildReportCalls, [{
      userId: 7,
      ledgerId: null,
      periodType: 'month',
      periodValue: '2026-07',
      filters: {
        category: undefined,
        member: undefined,
        merchant: undefined,
        project: undefined
      }
    }])
  } finally {
    server.close()
  }
})

test('GET /api/export/excel uses the local month at the start of a month', async () => {
  const buildReportCalls = []
  const now = () => new Date(2026, 7, 1, 0, 30)
  const { server, url } = await listen(appWithRouter(buildReportCalls, { now }))
  try {
    const response = await fetch(`${url}/api/export/excel`, {
      headers: { Authorization: `Bearer ${token()}` }
    })
    assert.equal(response.status, 200)
    assert.equal(buildReportCalls[0].periodValue, '2026-08')
  } finally {
    server.close()
  }
})

test('GET /api/export formats return expected content types and report parameters', async () => {
  const buildReportCalls = []
  const { server, url } = await listen(appWithRouter(buildReportCalls))
  try {
    for (const [format, contentType] of [
      ['excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['pdf', 'application/pdf'],
      ['image', 'image/png']
    ]) {
      const response = await fetch(
        `${url}/api/export/${format}?periodType=month&periodValue=2026-07&ledgerId=12&category=food&member=me&merchant=cafe&project=trip`,
        { headers: { Authorization: `Bearer ${token()}` } }
      )
      assert.equal(response.status, 200)
      assert.ok(response.headers.get('content-type').includes(contentType))
      assert.match(response.headers.get('content-disposition'), /^attachment; filename="report-\d+\.(xlsx|pdf|png)"$/)
      assert.ok((await response.arrayBuffer()).byteLength > 0)
    }

    assert.equal(buildReportCalls.length, 3)
    for (const params of buildReportCalls) {
      assert.deepEqual(params, {
        userId: 7,
        ledgerId: 12,
        periodType: 'month',
        periodValue: '2026-07',
        filters: {
          category: 'food',
          member: 'me',
          merchant: 'cafe',
          project: 'trip'
        }
      })
    }
  } finally {
    server.close()
  }
})
