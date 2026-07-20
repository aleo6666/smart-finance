import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createHealthRouter } from '../src/routes/health.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

test('GET /api/health returns cheap liveness without dependency checks', async () => {
  const app = express()
  app.use('/api/health', createHealthRouter())

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/health`)
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.ok(json.message)
  } finally {
    server.close()
  }
})

test('GET /api/health/ready returns 200 when all healthy', async () => {
  const app = express()
  app.use('/api/health', createHealthRouter({
    checkDeps: async () => ({
      status: 'ready',
      services: {
        mysql: { ok: true },
        redis: { ok: true },
        qdrant: { ok: true },
        lmStudioModels: { ok: true },
        lmStudioEmbedding: { ok: true, dimensions: 768 },
        lmStudioChat: { ok: true }
      }
    }),
    createChecks: () => ({})
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/health/ready`)
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.status, 'ready')
  } finally {
    server.close()
  }
})

test('GET /api/health/ready returns 503 when degraded', async () => {
  const app = express()
  app.use('/api/health', createHealthRouter({
    checkDeps: async () => ({
      status: 'degraded',
      services: {
        mysql: { ok: true },
        redis: { ok: false, reason: 'connection refused' },
        qdrant: { ok: true },
        lmStudioModels: { ok: true },
        lmStudioEmbedding: { ok: true, dimensions: 768 },
        lmStudioChat: { ok: true }
      }
    }),
    createChecks: () => ({})
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/health/ready`)
    const json = await response.json()
    assert.equal(response.status, 503)
    assert.equal(json.status, 'degraded')
  } finally {
    server.close()
  }
})
