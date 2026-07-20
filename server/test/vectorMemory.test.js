import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeterministicEmbedding, embedRecord, recordToTextBlock, retrieveSimilar, initVectorCollection, VectorDimensionError, deleteRecordVector } from '../src/services/vectorMemory.js'

test('createDeterministicEmbedding returns stable fixed-size vectors', () => {
  const first = createDeterministicEmbedding('lunch 25', 16)
  const second = createDeterministicEmbedding('lunch 25', 16)
  const different = createDeterministicEmbedding('taxi 18', 16)

  assert.equal(first.length, 16)
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, different)
  assert.ok(first.every(value => value >= -1 && value <= 1))
})

test('retrieveSimilar searches Qdrant with user month and category filters', async () => {
  const calls = []
  const client = {
    async search(collection, payload) {
      calls.push({ collection, payload })
      return [{
        score: 0.91,
        payload: {
          recordId: 12,
          userId: 7,
          date: '2026-07-18',
          month: '2026-07',
          category: '餐饮',
          amount: 88,
          merchant: '食堂',
          description: '午饭'
        }
      }]
    }
  }

  const records = await retrieveSimilar('本月餐饮', {
    userId: 7,
    month: '2026-07',
    category: '餐饮',
    limit: 3,
    client,
    collection: 'finance_records',
    getEmbedding: async () => [0.1, 0.2]
  })

  assert.equal(records.length, 1)
  assert.equal(records[0].recordId, 12)
  assert.equal(records[0].score, 0.91)
  assert.equal(calls[0].collection, 'finance_records')
  assert.deepEqual(calls[0].payload.vector, [0.1, 0.2])
  assert.equal(calls[0].payload.limit, 3)
  assert.deepEqual(calls[0].payload.filter.must, [
    { key: 'userId', match: { value: 7 } },
    { key: 'month', match: { value: '2026-07' } },
    { key: 'category', match: { value: '餐饮' } }
  ])
})

test('retrieveSimilar returns empty array without userId', async () => {
  let searched = false
  const records = await retrieveSimilar('餐饮', {
    client: { search: async () => { searched = true; return [] } },
    getEmbedding: async () => [0.1]
  })

  assert.deepEqual(records, [])
  assert.equal(searched, false)
})

test('retrieveSimilar degrades to empty array when Qdrant fails', async () => {
  const records = await retrieveSimilar('餐饮', {
    userId: 7,
    client: { search: async () => { throw new Error('qdrant down') } },
    getEmbedding: async () => [0.1]
  })

  assert.deepEqual(records, [])
})

test('embedRecord upserts record payload to vector client', async () => {
  const calls = []
  const client = {
    upsert(collection, payload) {
      calls.push({ collection, payload })
      return Promise.resolve()
    }
  }
  const record = {
    id: 9,
    user_id: 2,
    type: 'expense',
    amount: 25,
    amount_cny: 25,
    category: '餐饮',
    merchant: '食堂',
    description: '午饭',
    date: '2026-07-17'
  }

  await embedRecord(record, {
    client,
    collection: 'finance_records',
    getEmbedding: async text => createDeterministicEmbedding(text, 8)
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].collection, 'finance_records')
  assert.equal(calls[0].payload.points[0].id, 9)
  assert.equal(calls[0].payload.points[0].vector.length, 8)
  assert.equal(calls[0].payload.points[0].payload.recordId, 9)
  assert.match(recordToTextBlock(record), /午饭/)
})

test('initVectorCollection probes embedding size and creates versioned collection', async () => {
  const calls = []
  const client = {
    getCollections: async () => ({ collections: [] }),
    createCollection: async (name, body) => calls.push({ name, body })
  }
  const result = await initVectorCollection({
    client,
    collection: 'finance_records_nomic_v1',
    embeddingClient: { embed: async text => { assert.equal(text, '维度探针'); return [0.1, 0.2, 0.3] } }
  })
  assert.equal(result.size, 3)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'finance_records_nomic_v1')
  assert.deepEqual(calls[0].body, { vectors: { size: 3, distance: 'Cosine' } })
})

test('initVectorCollection returns existing size when collection exists with matching dimensions', async () => {
  const client = {
    getCollections: async () => ({ collections: [{ name: 'finance_records_nomic_v1' }] }),
    getCollection: async (name) => ({
      config: { params: { vectors: { size: 3 } } }
    }),
    createCollection: async () => { throw new Error('should not recreate') }
  }
  const result = await initVectorCollection({
    client,
    collection: 'finance_records_nomic_v1',
    embeddingClient: { embed: async () => [0.1, 0.2, 0.3] }
  })
  assert.equal(result.size, 3)
})

test('initVectorCollection throws VectorDimensionError on dimension mismatch', async () => {
  const client = {
    getCollections: async () => ({ collections: [{ name: 'finance_records_nomic_v1' }] }),
    getCollection: async (name) => ({
      config: { params: { vectors: { size: 768 } } }
    }),
    createCollection: async () => { throw new Error('should not create') }
  }
  await assert.rejects(
    () => initVectorCollection({
      client,
      collection: 'finance_records_nomic_v1',
      embeddingClient: { embed: async () => [0.1, 0.2, 0.3] }
    }),
    (err) => {
      assert.ok(err instanceof VectorDimensionError)
      assert.match(err.message, /768.*3|3.*768/)
      return true
    }
  )
})

test('retrieveSimilar includes ledgerId and type in filter', async () => {
  const calls = []
  const client = {
    async search(collection, payload) {
      calls.push({ collection, payload })
      return []
    }
  }

  await retrieveSimilar('超市消费', {
    userId: 7,
    ledgerId: '42',
    type: 'expense',
    client,
    getEmbedding: async () => [0.1]
  })

  assert.equal(calls.length, 1)
  const must = calls[0].payload.filter.must
  assert.deepEqual(must, [
    { key: 'userId', match: { value: 7 } },
    { key: 'ledgerId', match: { value: '42' } },
    { key: 'type', match: { value: 'expense' } }
  ])
})

test('deleteRecordVector calls client.delete with the right point ID', async () => {
  const calls = []
  const client = {
    delete: async (collection, params) => calls.push({ collection, params })
  }

  await deleteRecordVector(99, {
    client,
    collection: 'finance_records_nomic_v1'
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].collection, 'finance_records_nomic_v1')
  assert.deepEqual(calls[0].params, { points: [99] })
})
