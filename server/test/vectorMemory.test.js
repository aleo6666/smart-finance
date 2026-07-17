import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeterministicEmbedding, embedRecord, recordToTextBlock, retrieveSimilar } from '../src/services/vectorMemory.js'

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
