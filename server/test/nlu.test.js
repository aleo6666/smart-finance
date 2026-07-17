import test from 'node:test'
import assert from 'node:assert/strict'
import { processMessage } from '../src/services/nlu.js'

test('processMessage parses simple expense record without database context', async () => {
  const result = await processMessage('user-1', '今天午饭花了25元')

  assert.equal(result.intent, 'record')
  assert.equal(result.data.type, 'expense')
  assert.equal(result.data.amount, 25)
  assert.ok(result.data.date)
})
