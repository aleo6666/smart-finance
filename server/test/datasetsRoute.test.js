import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createDatasetsRouter } from '../src/routes/datasets.js'
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

test('GET /api/datasets/bad-cases format=json uses authenticated user only', async () => {
  const calls = []
  const app = express()
  app.use('/api/datasets', createDatasetsRouter({
    buildBadCaseDataset: async input => {
      calls.push(input)
      return [{ source: 'ocr', messages: [], metadata: { userId: input.userId } }]
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/datasets/bad-cases?month=2026-07&source=all&format=json&userId=999`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(calls[0].userId, 7)
    assert.equal(calls[0].month, '2026-07')
    assert.equal(calls[0].source, 'all')
    assert.equal(json.data[0].metadata.userId, 7)
  } finally {
    server.close()
  }
})

test('GET /api/datasets/bad-cases returns JSONL content type by default', async () => {
  const app = express()
  app.use('/api/datasets', createDatasetsRouter({
    buildBadCaseDataset: async () => [{ source: 'insight', messages: [], metadata: { feedbackId: 1 } }]
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/datasets/bad-cases`, {
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/jsonl/)
    assert.equal(JSON.parse(text).source, 'insight')
  } finally {
    server.close()
  }
})

test('GET /api/datasets/bad-cases requires auth', async () => {
  const app = express()
  app.use('/api/datasets', createDatasetsRouter({
    buildBadCaseDataset: async () => []
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/datasets/bad-cases`)
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})
