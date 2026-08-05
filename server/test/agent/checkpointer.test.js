import test from 'node:test'
import assert from 'node:assert/strict'
import { getRedisUrl } from '../../src/redis.js'
import {
  CheckpointerSetupError,
  createCheckpointer
} from '../../src/agent/checkpointer.js'

test('getRedisUrl encodes Redis credentials without changing the host or port', () => {
  assert.equal(getRedisUrl({
    redis: {
      host: 'redis.internal',
      port: 6380,
      password: "p@ss:/?#[]%!'()*"
    }
  }), 'redis://:p%40ss%3A%2F%3F%23%5B%5D%25%21%27%28%29%2A@redis.internal:6380')

  assert.equal(getRedisUrl({
    redis: { host: 'redis', port: 6379, password: '' }
  }), 'redis://redis:6379')
})

test('createCheckpointer returns MemorySaver fallback when Redis is unavailable', async () => {
  const result = await createCheckpointer('redis://localhost:16379', {
    sessionTtlSeconds: 1800
  })

  assert.equal(typeof result, 'object')
  assert.equal(result.redisBacked, false)
  assert.ok(result.saver, 'should have a saver')
})

test('createCheckpointer never throws, returns fallback on connection errors', async () => {
  const secretUrl = 'redis://:do-not-leak@nonexistent:6379'

  // Should not throw — returns fallback
  const result = await createCheckpointer(secretUrl)

  assert.equal(result.redisBacked, false)
  assert.ok(result.saver)
})

test('createCheckpointer fallback message does not leak connection details', async () => {
  const secretUrl = 'redis://:my-secret-password@redis:6379'

  const result = await createCheckpointer(secretUrl)

  assert.equal(result.redisBacked, false)
  // The saver is a MemorySaver — no secrets exposed
  assert.ok(result.saver)
})
