import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
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

test('buildPdfBuffer embeds the bundled Unicode font for Chinese text', async () => {
  const buffer = await buildPdfBuffer(report)
  const pdfBody = buffer.toString('latin1')
  assert.ok(pdfBody.includes('/ToUnicode'))
  assert.ok(pdfBody.includes('NotoSansSC-Regular'))
  assert.equal(pdfBody.includes('Helvetica'), false)
})

test('buildPdfBuffer rejects when the Chinese font is missing', async () => {
  const fontPath = fileURLToPath(new URL('./missing-font.otf', import.meta.url))
  await assert.rejects(buildPdfBuffer(report, { fontPath }), /缺少中文字体文件/)
})

test('buildImageBuffer creates png buffer', () => {
  const buffer = buildImageBuffer(report)
  assert.ok(Buffer.isBuffer(buffer))
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('buildImageBuffer registers the bundled Chinese font', () => {
  const calls = []
  const registerFontFn = (...args) => calls.push(args)
  const buffer = buildImageBuffer(report, { registerFontFn })

  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /NotoSansSC-Regular\.otf$/)
  assert.deepEqual(calls[0][1], { family: 'SmartFinanceCJK' })
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('buildImageBuffer throws when the Chinese font is missing', () => {
  const fontPath = fileURLToPath(new URL('./missing-font.otf', import.meta.url))
  assert.throws(() => buildImageBuffer(report, { fontPath }), /缺少中文字体文件/)
})

test('makeShareQr creates png qr buffer', async () => {
  const buffer = await makeShareQr('http://localhost/share/token')
  assert.ok(Buffer.isBuffer(buffer))
  assert.deepEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})
