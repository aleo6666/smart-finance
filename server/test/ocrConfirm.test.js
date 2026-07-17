import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeOcrRecord,
  isUserCorrected,
  saveConfirmedOcrRecords
} from '../src/services/ocrConfirm.js'

test('normalizeOcrRecord accepts a valid confirmed OCR record', () => {
  const record = normalizeOcrRecord({
    type: 'expense',
    amount: '25.50',
    category: '餐饮',
    description: '午餐',
    date: '2026-07-17',
    merchant: '某某餐厅'
  })

  assert.equal(record.type, 'expense')
  assert.equal(record.amount, 25.5)
  assert.equal(record.category, '餐饮')
  assert.equal(record.description, '午餐')
  assert.equal(record.date, '2026-07-17')
  assert.equal(record.merchant, '某某餐厅')
})

test('normalizeOcrRecord rejects invalid amount and date', () => {
  assert.throws(() => normalizeOcrRecord({ amount: 0, category: '餐饮', date: '2026-07-17' }), /金额必须大于 0/)
  assert.throws(() => normalizeOcrRecord({ amount: 1, category: '餐饮', date: '2026/07/17' }), /日期格式必须是 YYYY-MM-DD/)
})

test('isUserCorrected detects changed key fields', () => {
  const original = { amount: 25, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }
  assert.equal(isUserCorrected(original, { ...original }), false)
  assert.equal(isUserCorrected(original, { ...original, amount: 26 }), true)
  assert.equal(isUserCorrected(original, { ...original, category: '购物' }), true)
})

test('saveConfirmedOcrRecords inserts records and OCR evaluations', async () => {
  const insertedRecords = []
  const insertedEvaluations = []
  const embedded = []
  const monitored = []

  const repository = {
    async transaction(work) {
      return work('trx')
    },
    async insertRecord(record) {
      insertedRecords.push(record)
      return insertedRecords.length
    },
    async fetchRecord(id) {
      return { ...insertedRecords[id - 1], id }
    },
    async insertEvaluation(evaluation) {
      insertedEvaluations.push(evaluation)
    }
  }

  const result = await saveConfirmedOcrRecords({
    userId: 7,
    deviceId: 'user-7',
    session: {
      records: [{ amount: 25, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }]
    },
    confirmedRecords: [{ amount: 26, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }],
    repository,
    embedRecordFn: async record => embedded.push(record),
    checkBudgetAfterRecordFn: async input => monitored.push(input)
  })

  assert.equal(result.count, 1)
  assert.equal(result.records[0].id, 1)
  assert.equal(insertedRecords[0].user_id, 7)
  assert.equal(insertedRecords[0].amount, 26)
  assert.equal(insertedEvaluations[0].record_id, 1)
  assert.equal(insertedEvaluations[0].user_corrected, 1)
  assert.equal(insertedEvaluations[0].ocr_correct, 0)
  assert.equal(insertedEvaluations[0].corrected_amount, 26)
  assert.equal(embedded[0].id, 1)
  assert.equal(monitored[0].record.id, 1)
})
