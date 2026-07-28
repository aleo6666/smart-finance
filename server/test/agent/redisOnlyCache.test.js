import test from 'node:test'
import assert from 'node:assert/strict'
import { createRedisOnlyCache } from '../../src/redis.js'

test('Redis-only cache propagates failures without logging sensitive values', async () => {
  const sensitive = 'private-agent-memory'
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)

  try {
    const cache = createRedisOnlyCache({
      getClient: () => ({
        status: 'ready',
        get: async () => { throw new Error(sensitive) },
        set: async () => { throw new Error(sensitive) },
        del: async () => { throw new Error(sensitive) }
      })
    })

    await assert.rejects(cache.set('agent:key', { sensitive }, 60), {
      message: sensitive
    })
    await assert.rejects(cache.get('agent:key'), { message: sensitive })
    await assert.rejects(cache.del('agent:key'), { message: sensitive })
    assert.equal(JSON.stringify(warnings).includes(sensitive), false)
  } finally {
    console.warn = originalWarn
  }
})

test('Redis-only cache preserves JSON serialization and TTL semantics', async () => {
  const calls = []
  const cache = createRedisOnlyCache({
    getClient: () => ({
      status: 'ready',
      get: async key => {
        calls.push(['get', key])
        return '{"ok":true}'
      },
      set: async (...args) => calls.push(['set', ...args]),
      del: async key => calls.push(['del', key])
    })
  })

  await cache.set('agent:key', { ok: true }, 60)
  assert.deepEqual(await cache.get('agent:key'), { ok: true })
  await cache.del('agent:key')

  assert.deepEqual(calls, [
    ['set', 'agent:key', '{"ok":true}', 'EX', 60],
    ['get', 'agent:key'],
    ['del', 'agent:key']
  ])
})
