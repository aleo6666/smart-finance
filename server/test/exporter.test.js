import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExcelBuffer,
  buildImageBuffer,
  buildPdfBuffer,
  makeShareQr
} from '../src/services/exporter.js'

const report = {
  income: 500,
  expense: 125,
  balance: 375,
  byCategory: [{ category: '餐饮', total: 125, count: 5 }],
  records: [{
    date: '2026-07-18',
    type: 'expense',
    category: '餐饮',
    amount: 25,
    currency: 'CNY',
    description: '午饭'
  }]
}

test('buildExcelBuffer creates xlsx buffer', async () => {
  const buffer = await buildExcelBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')
})

test('buildPdfBuffer creates pdf buffer', async () => {
  const buffer = await buildPdfBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF')
})

test('buildImageBuffer creates png buffer', () => {
  const buffer = buildImageBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('makeShareQr creates png qr buffer', async () => {
  const buffer = await makeShareQr('http://localhost/share/token')
  assert.ok(Buffer.isBuffer(buffer))
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})
