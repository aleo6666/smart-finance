import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatasetStore } from '../../src/agent/stores/datasetStore.js'

function createFakeCache() {
  const values = new Map()
  return {
    values,
    async set(key, value, ttlSeconds) {
      values.set(key, { value: structuredClone(value), ttlSeconds })
    },
    async get(key) {
      return structuredClone(values.get(key)?.value ?? null)
    }
  }
}

test('dataset store keeps raw rows in request-scoped Redis and returns only a reference', async () => {
  const cache = createFakeCache()
  const store = createDatasetStore({
    cache,
    ttlSeconds: 300,
    randomId: () => 'fixed-id'
  })

  const reference = await store.put({
    userId: 7,
    requestId: 'request-1',
    rows: [{ amount: 25 }],
    summary: { total: 25 },
    scope: { month: '2026-07', category: '餐饮' }
  })

  assert.deepEqual(reference, {
    datasetRef: 'ds_fixed-id',
    count: 1,
    scope: { month: '2026-07', category: '餐饮' }
  })
  assert.equal(JSON.stringify(reference).includes('amount'), false)
  assert.deepEqual(await store.get({
    userId: 7,
    requestId: 'request-1',
    datasetRef: 'ds_fixed-id'
  }), {
    rows: [{ amount: 25 }],
    summary: { total: 25 },
    scope: { month: '2026-07', category: '餐饮' }
  })
  assert.equal([...cache.values.values()][0].ttlSeconds, 300)
})

test('dataset store rejects cross-request references without probing another scope', async () => {
  const store = createDatasetStore({
    cache: createFakeCache(),
    ttlSeconds: 300,
    randomId: () => 'fixed-id'
  })
  await store.put({
    userId: 7,
    requestId: 'request-1',
    rows: [{ amount: 25 }]
  })

  await assert.rejects(
    store.get({
      userId: 7,
      requestId: 'request-2',
      datasetRef: 'ds_fixed-id'
    }),
    error => error.code === 'DATASET_SCOPE_MISMATCH'
  )
})

test('dataset store rejects non JSON-safe rows', async () => {
  const store = createDatasetStore({
    cache: createFakeCache(),
    ttlSeconds: 300
  })

  await assert.rejects(
    store.put({
      userId: 7,
      requestId: 'request-1',
      rows: [{ amount: undefined }]
    }),
    error => error.code === 'INVALID_DATASET'
  )
})

test('dataset store treats other users, expired values, and malformed refs alike', async () => {
  const cache = createFakeCache()
  const store = createDatasetStore({
    cache,
    ttlSeconds: 300,
    randomId: () => 'fixed-id'
  })
  await store.put({
    userId: 7,
    requestId: 'request-1',
    rows: []
  })

  for (const input of [
    { userId: 8, requestId: 'request-1', datasetRef: 'ds_fixed-id' },
    { userId: 7, requestId: 'request-1', datasetRef: '../ds_fixed-id' },
    { userId: 7, requestId: 'request-1', datasetRef: 'ds_missing' }
  ]) {
    await assert.rejects(
      store.get(input),
      error => error.code === 'DATASET_SCOPE_MISMATCH'
    )
  }
})

test('dataset store fails closed when Redis is unavailable', async () => {
  const writeStore = createDatasetStore({
    cache: {
      async set() { throw new Error('redis down') },
      async get() { return null }
    },
    ttlSeconds: 300
  })
  await assert.rejects(
    writeStore.put({ userId: 7, requestId: 'request-1', rows: [] }),
    error => error.code === 'DATASET_STORE_UNAVAILABLE' && error.statusCode === 503
  )

  const readStore = createDatasetStore({
    cache: {
      async set() {},
      async get() { throw new Error('redis down') }
    },
    ttlSeconds: 300
  })
  await assert.rejects(
    readStore.get({
      userId: 7,
      requestId: 'request-1',
      datasetRef: 'ds_valid'
    }),
    error => error.code === 'DATASET_STORE_UNAVAILABLE' && error.statusCode === 503
  )
})

test('dataset store enforces row, byte, and scope bounds', async () => {
  const store = createDatasetStore({
    cache: createFakeCache(),
    ttlSeconds: 300,
    maxRows: 1,
    maxBytes: 100
  })
  await assert.rejects(
    store.put({ userId: 7, requestId: 'request-1', rows: [{}, {}] }),
    error => error.code === 'INVALID_DATASET'
  )
  await assert.rejects(
    store.put({
      userId: 7,
      requestId: 'request-1',
      rows: [{ description: 'x'.repeat(200) }]
    }),
    error => error.code === 'INVALID_DATASET'
  )
  await assert.rejects(
    store.put({
      userId: 7,
      requestId: 'request-1',
      rows: [],
      scope: { userId: '8' }
    }),
    error => error.code === 'INVALID_DATASET'
  )
})
