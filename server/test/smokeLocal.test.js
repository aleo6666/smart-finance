import test from 'node:test'
import assert from 'node:assert/strict'
import { runLocalSmoke } from '../src/scripts/smoke-local.js'

test('runLocalSmoke executes full smoke flow', async () => {
  let cleanupCalled = false
  let stepIndex = 0

  async function fakeFetch(url, options = {}) {
    const step = stepIndex++
    const body = options.body ? JSON.parse(options.body) : {}
    const auth = options.headers?.Authorization || ''

    // Step 0-1: register + login
    if (url.includes('/api/auth/register') || url.includes('/api/auth/login')) {
      return resp(200, { success: true, data: { token: 'smoke-token' } })
    }
    // Step 2: read ledgers
    if (url.includes('/api/ledgers')) {
      return resp(200, { success: true, data: [{ id: 1, name: '默认账本' }] })
    }
    // Step 3-5: create records (3 calls)
    if (url.includes('/api/records') && options.method === 'POST') {
      return resp(200, { success: true, data: { id: step - 1 } })
    }
    // Step 6: poll readiness/health
    if (url.includes('/api/health/ready')) {
      return resp(200, { status: 'ready', services: { mysql: { ok: true }, redis: { ok: true }, qdrant: { ok: true }, lmStudioModels: { ok: true }, lmStudioEmbedding: { ok: true, dimensions: 768 }, lmStudioChat: { ok: true } } })
    }
    // Step 7: exact query
    if (url.includes('/api/chat') && body.message?.includes('统计')) {
      return resp(200, { success: true, data: { intent: 'query', message: '共3笔', finance: { count: 3, total: 150, average: 50 } } })
    }
    // Step 8: advice query
    if (url.includes('/api/chat') && body.message?.includes('建议')) {
      return resp(200, { success: true, data: { intent: 'advice', message: '建议...', rag: { records: 3, sources: [1, 2, 3] } } })
    }
    return resp(404, {})
  }

  function resp(status, body) { return { ok: status < 400, status, json: async () => body } }

  const result = await runLocalSmoke({
    baseUrl: 'http://localhost:3000',
    fetchFn: fakeFetch,
    cleanupFn: async () => { cleanupCalled = true }
  })

  assert.equal(result.status, 'passed')
  assert.equal(cleanupCalled, true)
})

test('runLocalSmoke calls cleanup even when assertion fails', async () => {
  let cleanupCalled = false
  let callCount = 0

  async function fakeFetch() {
    callCount++
    if (callCount > 5) {
      return { ok: false, status: 500, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  }

  const result = await runLocalSmoke({
    baseUrl: 'http://localhost:3000',
    fetchFn: fakeFetch,
    cleanupFn: async () => { cleanupCalled = true }
  })

  assert.equal(result.status, 'failed')
  assert.equal(cleanupCalled, true)
})
