import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeterministicEmbedding, embedRecord, recordToTextBlock } from '../src/services/vectorMemory.js'

test('createDeterministicEmbedding returns stable fixed-size vectors', () => {
  const first = createDeterministicEmbedding('lunch 25', 16)
  const second = createDeterministicEmbedding('lunch 25', 16)
  const different = createDeterministicEmbedding('taxi 18', 16)

  assert.equal(first.length, 16)
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, different)
  assert.ok(first.every(value => value >= -1 && value <= 1))
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
  assert.equal(calls[0].payload.points[0].id, '9')
  assert.equal(calls[0].payload.points[0].vector.length, 8)
  assert.equal(calls[0].payload.points[0].payload.recordId, 9)
  assert.match(recordToTextBlock(record), /午饭/)
})
