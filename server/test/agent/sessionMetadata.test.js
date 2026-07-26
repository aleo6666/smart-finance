import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionMetadataStore } from '../../src/agent/memory/sessionMetadata.js'
import { RuntimeContextValidationError } from '../../src/agent/runtime.js'

test('session metadata writes the exact whitelist to its scoped key with TTL', async () => {
  const writes = []
  const store = createSessionMetadataStore({
    cache: {
      get: async () => null,
      set: async (...args) => writes.push(args),
      del: async () => {}
    },
    ttlSeconds: 1800,
    now: () => 1785030000000
  })

  const value = await store.write(7, 's-1', {
    deviceType: 'MOBILE',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN, en;q=0.8',
    inputMode: 'voice',
    responseStyle: 'concise',
    lastActiveAt: 1785029999999,
    userId: 999,
    isAdmin: true,
    authorization: 'secret',
    rawRequest: { password: 'secret' }
  })

  assert.deepEqual(value, {
    deviceType: 'mobile',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inputMode: 'voice',
    responseStyle: 'concise',
    lastActiveAt: 1785029999999
  })
  assert.deepEqual(writes, [[
    'agent:session:7:s-1',
    value,
    1800
  ]])
})

test('session metadata normalizes untrusted values and clears the scoped key', async () => {
  const deleted = []
  const store = createSessionMetadataStore({
    cache: {
      get: async () => null,
      set: async () => {},
      del: async key => deleted.push(key)
    },
    ttlSeconds: 60,
    now: () => 123
  })

  assert.deepEqual(await store.write(8, 'trusted.session', {
    deviceType: 'x'.repeat(100),
    timezone: '../../etc/passwd',
    locale: 'not_a_locale',
    inputMode: 'arbitrary',
    responseStyle: 'x'.repeat(100),
    lastActiveAt: -1
  }), {
    deviceType: 'unknown',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inputMode: 'text',
    responseStyle: 'concise',
    lastActiveAt: 123
  })

  assert.equal(await store.clear(8, 'trusted.session'), true)
  assert.deepEqual(deleted, ['agent:session:8:trusted.session'])
})

test('session metadata reads only normalized whitelisted fields', async () => {
  const store = createSessionMetadataStore({
    cache: {
      get: async () => ({
        deviceType: 'tablet',
        timezone: 'UTC',
        locale: 'en-US',
        inputMode: 'text',
        responseStyle: 'detailed',
        lastActiveAt: 99,
        token: 'must-not-return'
      }),
      set: async () => {},
      del: async () => {}
    },
    ttlSeconds: 60
  })

  assert.deepEqual(await store.read(2, 's-2'), {
    deviceType: 'tablet',
    timezone: 'UTC',
    locale: 'en-US',
    inputMode: 'text',
    responseStyle: 'detailed',
    lastActiveAt: 99
  })
})

test('session metadata cache failures degrade to empty values without exposing data', async () => {
  const sensitive = 'private-metadata-value'
  const store = createSessionMetadataStore({
    cache: {
      get: async () => { throw new Error(sensitive) },
      set: async () => { throw new Error(sensitive) },
      del: async () => { throw new Error(sensitive) }
    },
    ttlSeconds: 60,
    now: () => 123
  })

  assert.deepEqual(await store.read(3, 's-3'), {})
  assert.equal(await store.write(3, 's-3', { locale: sensitive }), null)
  assert.equal(await store.clear(3, 's-3'), false)
})

test('session metadata rejects invalid user and session scope before cache access', async () => {
  let accesses = 0
  const store = createSessionMetadataStore({
    cache: {
      get: async () => { accesses += 1 },
      set: async () => { accesses += 1 },
      del: async () => { accesses += 1 }
    },
    ttlSeconds: 60
  })

  await assert.rejects(store.read(0, 's-1'), RuntimeContextValidationError)
  await assert.rejects(store.write(1, 'bad/session', {}), RuntimeContextValidationError)
  await assert.rejects(store.clear(1.5, 's-1'), RuntimeContextValidationError)
  assert.equal(accesses, 0)
})
