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

test('createCheckpointer configures shallow TTL, refreshes reads, and initializes injected savers', async () => {
  const calls = []
  const saver = {
    async setup() {
      calls.push(['setup'])
    }
  }
  const saverFactory = {
    async fromUrl(url, options) {
      calls.push(['fromUrl', url, options])
      return saver
    }
  }

  const value = await createCheckpointer('redis://redis:6379', {
    sessionTtlSeconds: 1800,
    saverFactory
  })

  assert.equal(value, saver)
  assert.deepEqual(calls, [
    ['fromUrl', 'redis://redis:6379', {
      defaultTTL: 30,
      refreshOnRead: true
    }],
    ['setup']
  ])
})

test('createCheckpointer wraps setup failures in a typed safe error', async () => {
  const secretUrl = 'redis://:do-not-leak@redis:6379'
  const saverFactory = {
    async fromUrl() {
      throw new Error(`connection failed for ${secretUrl}`)
    }
  }

  await assert.rejects(
    createCheckpointer(secretUrl, { saverFactory }),
    error => {
      assert.equal(error instanceof CheckpointerSetupError, true)
      assert.equal(error.code, 'ERR_CHECKPOINTER_SETUP')
      assert.equal(error.expose, false)
      assert.equal(error.message.includes('do-not-leak'), false)
      assert.equal(error.message.includes(secretUrl), false)
      return true
    }
  )
})
