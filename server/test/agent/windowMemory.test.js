import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWindowMemory,
  defaultEstimateTokens,
  trimWindow
} from '../../src/agent/memory/windowMemory.js'
import { RuntimeContextValidationError } from '../../src/agent/runtime.js'
import { agentRedisCache } from '../../src/redis.js'

function createCache(initial = []) {
  const writes = []
  let value = initial
  return {
    writes,
    cache: {
      get: async () => value,
      set: async (key, next, ttl) => {
        value = next
        writes.push({ key, value: next, ttl })
      },
      del: async () => {}
    }
  }
}

test('window applies count and token limits by removing oldest messages', async () => {
  const { cache, writes } = createCache()
  const store = createWindowMemory({
    cache,
    maxMessages: 2,
    maxTokens: 8,
    ttlSeconds: 1800,
    estimateTokens: text => text.length,
    now: () => 50
  })

  const value = await store.append(7, 's-1', [
    { role: 'user', content: '12345', metadata: { raw: true } },
    { role: 'assistant', content: '6789' },
    { role: 'user', content: 'abc' }
  ])

  assert.deepEqual(value, [
    { role: 'assistant', content: '6789', ts: 50 },
    { role: 'user', content: 'abc', ts: 50 }
  ])
  assert.deepEqual(writes, [{
    key: 'agent:window:7:s-1',
    value,
    ttl: 1800
  }])
})

test('window clips a final oversized message so it never exceeds the token cap', () => {
  const value = trimWindow([
    { role: 'user', content: 'abcdefghij', ts: 1 }
  ], {
    maxMessages: 3,
    maxTokens: 4,
    estimateTokens: text => text.length,
    now: () => 1
  })

  assert.deepEqual(value, [
    { role: 'user', content: 'abcd', ts: 1 }
  ])
  assert.equal(value.reduce((sum, item) => sum + item.content.length, 0) <= 4, true)
})

test('window sanitizes tool results to safe text and dataset references only', async () => {
  const { cache } = createCache()
  const store = createWindowMemory({
    cache,
    maxMessages: 10,
    maxTokens: 100,
    ttlSeconds: 60,
    estimateTokens: text => text.length,
    now: () => 10
  })

  const value = await store.append(1, 'tool-session', [{
    role: 'tool',
    content: {
      text: '35 matching rows',
      datasetRef: 'ds_safe-1',
      rows: [{ account: 'secret', amount: 99 }],
      token: 'do-not-persist'
    },
    tool_call_id: 'raw-call',
    artifact: { raw: true },
    ts: '9'
  }, {
    role: 'system',
    content: 'must be dropped'
  }])

  assert.deepEqual(value, [{
    role: 'tool',
    content: '35 matching rows [datasetRef:ds_safe-1]',
    ts: 9
  }])
  assert.equal(JSON.stringify(value).includes('secret'), false)
  assert.equal(JSON.stringify(value).includes('do-not-persist'), false)
  assert.equal(JSON.stringify(value).includes('raw-call'), false)
})

test('window read sanitizes invalid cache data and cache failures degrade safely', async () => {
  const invalidStore = createWindowMemory({
    cache: {
      get: async () => ({ transcript: ['raw'] }),
      set: async () => {},
      del: async () => {}
    },
    maxMessages: 3,
    maxTokens: 20,
    ttlSeconds: 60
  })
  assert.deepEqual(await invalidStore.read(1, 's-1'), [])

  const failingStore = createWindowMemory({
    cache: {
      get: async () => { throw new Error('private transcript') },
      set: async () => { throw new Error('private transcript') },
      del: async () => {}
    },
    maxMessages: 3,
    maxTokens: 20,
    ttlSeconds: 60,
    now: () => 1
  })
  assert.deepEqual(await failingStore.read(1, 's-1'), [])
  assert.deepEqual(await failingStore.append(1, 's-1', [
    { role: 'user', content: 'hello' }
  ]), [{ role: 'user', content: 'hello', ts: 1 }])
})

test('window default cache does not read an in-process backup after Redis fails', async () => {
  const sensitive = 'private-default-window'
  const original = {
    get: agentRedisCache.get,
    set: agentRedisCache.set,
    del: agentRedisCache.del
  }
  const originalWarn = console.warn
  console.warn = () => {}
  agentRedisCache.get = async () => { throw new Error(sensitive) }
  agentRedisCache.set = async () => { throw new Error(sensitive) }
  agentRedisCache.del = async () => { throw new Error(sensitive) }

  try {
    const store = createWindowMemory({
      maxMessages: 3,
      maxTokens: 20,
      ttlSeconds: 60,
      now: () => 1
    })
    await store.append(31, 'redis-only-window', [
      { role: 'user', content: sensitive }
    ])
    assert.deepEqual(await store.read(31, 'redis-only-window'), [])
  } finally {
    Object.assign(agentRedisCache, original)
    console.warn = originalWarn
  }
})

test('window rejects invalid scope before accessing cache', async () => {
  let accesses = 0
  const store = createWindowMemory({
    cache: {
      get: async () => { accesses += 1 },
      set: async () => { accesses += 1 },
      del: async () => { accesses += 1 }
    },
    maxMessages: 3,
    maxTokens: 20,
    ttlSeconds: 60
  })

  await assert.rejects(store.read(false, 's-1'), RuntimeContextValidationError)
  await assert.rejects(store.append(1, '../unsafe', []), RuntimeContextValidationError)
  assert.equal(accesses, 0)
})

test('default token estimation is conservative for Chinese text', () => {
  assert.equal(defaultEstimateTokens('一二三四') >= 4, true)
  assert.equal(defaultEstimateTokens('four ascii words') >= 3, true)
})

test('window has no raw transcript backup API or side write', async () => {
  const { cache, writes } = createCache()
  const store = createWindowMemory({
    cache,
    maxMessages: 1,
    maxTokens: 3,
    ttlSeconds: 60,
    estimateTokens: text => text.length,
    now: () => 1
  })

  await store.append(1, 's-1', [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'new' }
  ])

  assert.deepEqual(Object.keys(store).sort(), ['append', 'clear', 'read'])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].key, 'agent:window:1:s-1')
})
