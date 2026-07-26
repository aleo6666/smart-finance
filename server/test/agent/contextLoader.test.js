import test from 'node:test'
import assert from 'node:assert/strict'
import { createContextLoader } from '../../src/agent/memory/contextLoader.js'
import { emptySummary } from '../../src/agent/memory/recentSummary.js'

test('context loader starts all four scoped memory reads concurrently', async () => {
  const calls = []
  const releases = []
  const pending = (layer, value) => (...args) => {
    calls.push({ layer, args })
    return new Promise(resolve => releases.push(() => resolve(value)))
  }
  const loader = createContextLoader({
    sessionMetadata: { read: pending(1, { timezone: 'Asia/Shanghai' }) },
    userMemory: { listActive: pending(2, [{ memoryKey: 'default_currency' }]) },
    recentSummary: { read: pending(3, { ...emptySummary(), currentTopics: ['预算'] }) },
    windowMemory: { read: pending(4, [{ role: 'user', content: '继续' }]) }
  })

  const loading = loader({ userId: 7, sessionId: 's-1' })
  await Promise.resolve()
  assert.deepEqual(calls.map(call => call.layer), [1, 2, 3, 4])
  assert.deepEqual(calls.map(call => call.args), [
    [7, 's-1'],
    [7],
    [7, 's-1'],
    [7, 's-1']
  ])
  for (const release of releases) release()

  assert.deepEqual(await loading, {
    sessionMetadata: { timezone: 'Asia/Shanghai' },
    userMemory: [{ memoryKey: 'default_currency' }],
    recentSummary: { ...emptySummary(), currentTopics: ['预算'] },
    messages: [{ role: 'user', content: '继续' }],
    memoryErrors: []
  })
})

test('context loader independently degrades failed layers without leaking errors', async () => {
  const loader = createContextLoader({
    sessionMetadata: { read: async () => { throw new Error('redis://:secret@host') } },
    userMemory: { listActive: async () => [{ memoryKey: 'default_currency' }] },
    recentSummary: { read: async () => { throw new Error('mysql password=secret') } },
    windowMemory: { read: async () => [{ role: 'assistant', content: 'ok' }] }
  })

  const result = await loader({ userId: 7, sessionId: 's-1' })

  assert.deepEqual(result, {
    sessionMetadata: {},
    userMemory: [{ memoryKey: 'default_currency' }],
    recentSummary: emptySummary(),
    messages: [{ role: 'assistant', content: 'ok' }],
    memoryErrors: [
      { layer: 1, code: 'MEMORY_LOAD_FAILED' },
      { layer: 3, code: 'MEMORY_LOAD_FAILED' }
    ]
  })
  assert.doesNotMatch(JSON.stringify(result), /secret|password|redis:|mysql/)
})

test('context loader exposes only memory context and never prefetches finance data', async () => {
  let forbiddenAccess = 0
  const stores = new Proxy({
    sessionMetadata: { read: async () => ({}) },
    userMemory: { listActive: async () => [] },
    recentSummary: { read: async () => emptySummary() },
    windowMemory: { read: async () => [] }
  }, {
    get(target, property, receiver) {
      if (['transactions', 'budgets', 'datasetRefs', 'qdrant'].includes(property)) {
        forbiddenAccess += 1
        throw new Error(`forbidden prefetch: ${String(property)}`)
      }
      return Reflect.get(target, property, receiver)
    }
  })

  const result = await createContextLoader(stores)({
    userId: 7,
    sessionId: 'trusted.session'
  })

  assert.equal(forbiddenAccess, 0)
  assert.deepEqual(Object.keys(result), [
    'sessionMetadata',
    'userMemory',
    'recentSummary',
    'messages',
    'memoryErrors'
  ])
  for (const forbidden of ['transactions', 'budgets', 'datasetRefs', 'qdrant']) {
    assert.equal(forbidden in result, false)
  }
})
