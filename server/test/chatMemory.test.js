import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMemoryReply,
  extractQueryHints,
  summarizeRecords
} from '../src/services/chatMemory.js'

test('extractQueryHints detects month and category', () => {
  const currentMonth = '2026-07'
  const previousMonth = '2026-06'

  assert.deepEqual(extractQueryHints('本月餐饮花了多少', { now: new Date('2026-07-18') }), {
    month: currentMonth,
    category: '餐饮'
  })
  assert.deepEqual(extractQueryHints('上月购物怎么样', { now: new Date('2026-07-18') }), {
    month: previousMonth,
    category: '购物'
  })
})

test('summarizeRecords totals amount and categories', () => {
  const summary = summarizeRecords([
    { amount: 20, category: '餐饮' },
    { amount: 30, category: '餐饮' },
    { amount: 10, category: '交通' }
  ])

  assert.equal(summary.count, 3)
  assert.equal(summary.total, 60)
  assert.deepEqual(summary.categories, ['餐饮', '交通'])
})

test('buildMemoryReply returns existing message when no records found', () => {
  const reply = buildMemoryReply({
    intent: 'query',
    baseMessage: '我可以帮你查看消费统计。',
    records: []
  })

  assert.equal(reply, '我可以帮你查看消费统计。')
})

test('buildMemoryReply creates query reply from retrieved records', () => {
  const reply = buildMemoryReply({
    intent: 'query',
    baseMessage: '我可以帮你查看消费统计。',
    records: [
      { amount: 20, category: '餐饮' },
      { amount: 30, category: '餐饮' }
    ]
  })

  assert.match(reply, /找到 2 条相关记录/)
  assert.match(reply, /约 50\.00 元/)
  assert.match(reply, /餐饮/)
})

test('buildMemoryReply creates conservative advice from retrieved records', () => {
  const reply = buildMemoryReply({
    intent: 'advice',
    baseMessage: '建议先保持记账。',
    records: [
      { amount: 20, category: '餐饮' },
      { amount: 30, category: '餐饮' }
    ]
  })

  assert.match(reply, /这类支出近期较集中/)
  assert.match(reply, /餐饮/)
})
