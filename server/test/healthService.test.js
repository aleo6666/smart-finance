import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDependencies } from '../src/services/healthService.js'

test('checkDependencies returns ready when all services healthy', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.services.mysql.ok, true)
  assert.equal(result.services.lmStudioEmbedding.dimensions, 768)
})

test('checkDependencies returns degraded when one service fails', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: false, reason: 'connection refused' }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.status, 'degraded')
  assert.equal(result.services.redis.ok, false)
  assert.equal(result.services.redis.reason, 'connection refused')
})

test('mysql check failure returns safe short reason with no stack', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3306') },
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.services.mysql.ok, false)
  assert.ok(result.services.mysql.reason)
  assert.equal(result.services.mysql.reason.includes('at '), false)
})

test('redis check failure returns safe short reason with no stack', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => { throw new Error('connection refused') },
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.services.redis.ok, false)
  assert.ok(result.services.redis.reason)
  assert.equal(result.services.redis.reason.includes('at '), false)
})

test('qdrant check failure returns safe short reason with no stack', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      qdrant: async () => { throw new Error('fetch failed') },
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.services.qdrant.ok, false)
  assert.ok(result.services.qdrant.reason)
  assert.equal(result.services.qdrant.reason.includes('at '), false)
})

test('lmStudioModels check failure returns safe short reason with no stack', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => { throw new Error('ECONNREFUSED') },
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.services.lmStudioModels.ok, false)
  assert.ok(result.services.lmStudioModels.reason)
  assert.equal(result.services.lmStudioModels.reason.includes('at '), false)
})

test('lmStudioEmbedding check failure returns safe short reason with no stack', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => { throw new Error('timeout') },
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.services.lmStudioEmbedding.ok, false)
  assert.ok(result.services.lmStudioEmbedding.reason)
  assert.equal(result.services.lmStudioEmbedding.reason.includes('at '), false)
})

test('lmStudioChat check failure returns safe short reason with no stack', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => { throw new Error('500 Internal Server Error') }
    }
  })
  assert.equal(result.services.lmStudioChat.ok, false)
  assert.ok(result.services.lmStudioChat.reason)
  assert.equal(result.services.lmStudioChat.reason.includes('at '), false)
})

test('reason never contains password-like strings', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => { throw new Error('Access denied for user root using password FinancePass2026!') },
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => ({ ok: true })
    }
  })
  assert.equal(result.services.mysql.ok, false)
  assert.equal(result.services.mysql.reason.includes('FinancePass2026'), false)
})

test('reason never contains prompt content', async () => {
  const result = await checkDependencies({
    checks: {
      mysql: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
      qdrant: async () => ({ ok: true }),
      lmStudioModels: async () => ({ ok: true }),
      lmStudioEmbedding: async () => ({ ok: true, dimensions: 768 }),
      lmStudioChat: async () => { throw new Error('Invalid response for prompt: 回复"OK"') }
    }
  })
  assert.equal(result.services.lmStudioChat.ok, false)
  assert.equal(result.services.lmStudioChat.reason.includes('回复'), false)
  assert.equal(result.services.lmStudioChat.reason.includes('OK'), false)
})
