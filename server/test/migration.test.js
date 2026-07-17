import test from 'node:test'
import assert from 'node:assert/strict'
import { mapRecordRow, normalizeDateTime } from '../src/scripts/migrate-sqlite-to-mysql.js'

test('mapRecordRow keeps record ids and fills amount_cny', () => {
  const row = {
    id: 7,
    device_id: 'dev',
    user_id: 2,
    ledger_id: null,
    amount: 12.5,
    amount_cny: null,
    currency: null,
    category: 'food',
    type: 'expense',
    description: null,
    date: '2026-07-17',
    created_at: '2026-07-17 18:00:00'
  }

  const mapped = mapRecordRow(row)

  assert.equal(mapped.id, 7)
  assert.equal(mapped.amount_cny, 12.5)
  assert.equal(mapped.currency, 'CNY')
  assert.equal(mapped.description, '')
  assert.equal(mapped.created_at, '2026-07-17 18:00:00')
})

test('normalizeDateTime converts sqlite iso text into mysql datetime text', () => {
  assert.equal(normalizeDateTime('2026-07-17T10:15:30.000Z'), '2026-07-17 10:15:30')
  assert.equal(normalizeDateTime(null), null)
})
