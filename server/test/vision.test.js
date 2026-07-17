import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanReceipt, validateOcrResult } from '../src/services/vision.js'

test('validateOcrResult normalizes valid Chinese OCR categories', () => {
  const result = validateOcrResult({
    records: [{
      type: 'expense',
      amount: '25',
      category: '餐饮',
      description: '午餐',
      date: '2026-07-17',
      merchant: '某某餐厅'
    }],
    summary: '识别到 1 条消费记录'
  })

  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].amount, 25)
  assert.equal(result.records[0].category, '餐饮')
  assert.equal(result.totalAmount, 25)
})

test('scanReceipt returns empty OCR result when ZHIPU_API_KEY is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-ocr-'))
  const file = join(dir, 'receipt.png')
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(300).fill(1)]))

  try {
    const result = await scanReceipt(file, 7, {
      zhipuApiKey: '',
      fetchImpl: async () => {
        throw new Error('fetch should not be called without key')
      }
    })

    assert.deepEqual(result.records, [])
    assert.match(result.summary, /未配置图片识别服务/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
