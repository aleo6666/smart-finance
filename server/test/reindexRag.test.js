import test from 'node:test'
import assert from 'node:assert/strict'
import { rebuildRagIndex } from '../src/scripts/reindex-rag.js'

test('rebuildRagIndex processes all records from batches', async () => {
  const indexed = []

  const result = await rebuildRagIndex({
    repository: {
      listBatch: async ({ afterId }) => afterId ? [] : [{ id: 1, user_id: 7 }]
    },
    vectorMemory: { embedRecord: async record => indexed.push(record) },
    batchSize: 100
  })

  assert.deepEqual(result, { processed: 1, indexed: 1, failed: 0 })
  assert.equal(indexed.length, 1)
  assert.equal(indexed[0].id, 1)
})

test('rebuildRagIndex increments failed and continues on embed error', async () => {
  const records = [
    { id: 1, user_id: 7, type: 'expense', amount: 10 },
    { id: 2, user_id: 7, type: 'expense', amount: 20 },
    { id: 3, user_id: 7, type: 'income', amount: 100 }
  ]
  let batchIndex = 0

  const result = await rebuildRagIndex({
    repository: {
      listBatch: async () => {
        if (batchIndex > 0) return []
        batchIndex++
        return records
      }
    },
    vectorMemory: {
      embedRecord: async (record) => {
        // Fail the second record only
        if (record.id === 2) throw new Error('embedding failure')
      }
    },
    batchSize: 100
  })

  assert.equal(result.processed, 3)
  assert.equal(result.indexed, 2)
  assert.equal(result.failed, 1)
})

test('rebuildRagIndex returns zeros for empty repository', async () => {
  const result = await rebuildRagIndex({
    repository: { listBatch: async () => [] },
    vectorMemory: { embedRecord: async () => {} },
    batchSize: 100
  })

  assert.deepEqual(result, { processed: 0, indexed: 0, failed: 0 })
})
