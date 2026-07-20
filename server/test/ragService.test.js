import test from 'node:test'
import assert from 'node:assert/strict'
import { createRagService } from '../src/services/ragService.js'

test('answer returns grounded Qwen response and record sources', async () => {
  const service = createRagService({
    retrieveSimilar: async () => [
      { recordId: 12, date: '2026-07-18', category: '餐饮', amount: 88, merchant: '食堂', description: '午餐', score: 0.91 }
    ],
    lmStudioClient: {
      chat: async messages => {
        assert.match(messages[0].content, /不得编造/)
        assert.match(messages[1].content, /记录ID: 12/)
        return '根据相关记录，建议先控制餐饮频率。'
      }
    },
    settings: { enabled: true, topK: 5, maxContextChars: 6000 }
  })
  const result = await service.answer({ question: '怎么减少日常开销？', userId: 7, hints: {} })
  assert.equal(result.message, '根据相关记录，建议先控制餐饮频率。')
  assert.deepEqual(result.sources, [12])
  assert.equal(result.records, 1)
})

test('answer forwards userId to retrieveSimilar', async () => {
  const retrieveCalls = []
  const service = createRagService({
    retrieveSimilar: async (question, options) => {
      retrieveCalls.push({ question, options })
      return [{ recordId: 1, date: '2026-07-18', category: '餐饮', amount: 50, merchant: '', description: '', score: 0.9 }]
    },
    lmStudioClient: { chat: async () => '少吃外卖。' },
    settings: { enabled: true, topK: 3, maxContextChars: 6000 }
  })
  await service.answer({ question: '怎么省钱？', userId: 42, hints: { category: '餐饮', month: '2026-07' } })
  assert.equal(retrieveCalls.length, 1)
  assert.equal(retrieveCalls[0].options.userId, 42)
  assert.equal(retrieveCalls[0].options.limit, 3)
  assert.equal(retrieveCalls[0].options.category, '餐饮')
})

test('answer truncates context when many records exceed maxContextChars', async () => {
  const records = Array.from({ length: 20 }, (_, i) => ({
    recordId: i + 1,
    date: '2026-07-18',
    category: '餐饮',
    amount: 10 + i,
    merchant: '餐厅',
    description: `第${i + 1}笔消费`,
    score: 0.9
  }))
  const chatMessages = []
  const service = createRagService({
    retrieveSimilar: async () => records,
    lmStudioClient: {
      chat: async messages => {
        chatMessages.push(...messages)
        return '建议控制餐饮开销。'
      }
    },
    settings: { enabled: true, topK: 20, maxContextChars: 500 }
  })
  const result = await service.answer({ question: '怎么减少开销？', userId: 7, hints: {} })
  assert.equal(result.message, '建议控制餐饮开销。')
  assert.ok(result.sources.length > 0)
  assert.ok(result.sources.length < 20, 'only subset of records should be included')
  assert.ok(result.records < 20)
  // Verify context was limited
  const userContent = chatMessages.find(m => m.role === 'user')?.content || ''
  assert.ok(userContent.length <= 800, 'user message should be bounded')
})

test('answer returns baseMessage when retrieveSimilar returns empty', async () => {
  let chatCalled = false
  const service = createRagService({
    retrieveSimilar: async () => [],
    lmStudioClient: {
      chat: async () => { chatCalled = true; return '' }
    },
    settings: { enabled: true, topK: 5, maxContextChars: 6000 }
  })
  const result = await service.answer({
    question: '怎么减少开销？',
    userId: 7,
    hints: {},
    baseMessage: '没有找到相关记录，无法提供建议。'
  })
  assert.equal(result.message, '没有找到相关记录，无法提供建议。')
  assert.deepEqual(result.sources, [])
  assert.equal(result.records, 0)
  assert.equal(chatCalled, false, 'chat should not be called when no records')
})

test('answer returns baseMessage when RAG is disabled', async () => {
  let retrieveCalled = false
  const service = createRagService({
    retrieveSimilar: async () => { retrieveCalled = true; return [] },
    lmStudioClient: { chat: async () => '不应该被调用' },
    settings: { enabled: false, topK: 5, maxContextChars: 6000 }
  })
  const result = await service.answer({
    question: '怎么减少开销？',
    userId: 7,
    hints: {},
    baseMessage: '当前无法提供智能建议，请查看统计数据。'
  })
  assert.equal(result.message, '当前无法提供智能建议，请查看统计数据。')
  assert.deepEqual(result.sources, [])
  assert.equal(result.records, 0)
  assert.equal(retrieveCalled, false, 'retrieveSimilar should not be called when disabled')
})

test('answer returns baseMessage when LM Studio chat throws', async () => {
  const service = createRagService({
    retrieveSimilar: async () => [
      { recordId: 12, date: '2026-07-18', category: '餐饮', amount: 88, merchant: '食堂', description: '午餐', score: 0.91 }
    ],
    lmStudioClient: {
      chat: async () => { throw new Error('LM Studio connection refused') }
    },
    settings: { enabled: true, topK: 5, maxContextChars: 6000 }
  })
  const result = await service.answer({
    question: '怎么减少开销？',
    userId: 7,
    hints: {},
    baseMessage: '暂时无法生成建议，请稍后再试。'
  })
  assert.equal(result.message, '暂时无法生成建议，请稍后再试。')
  assert.deepEqual(result.sources, [])
  assert.equal(result.records, 0)
})

test('answer deduplicates source record IDs', async () => {
  const service = createRagService({
    retrieveSimilar: async () => [
      { recordId: 12, date: '2026-07-18', category: '餐饮', amount: 88, merchant: '食堂', description: '午餐', score: 0.91 },
      { recordId: 12, date: '2026-07-18', category: '餐饮', amount: 88, merchant: '食堂', description: '午餐', score: 0.90 }
    ],
    lmStudioClient: { chat: async () => '建议合理消费。' },
    settings: { enabled: true, topK: 5, maxContextChars: 6000 }
  })
  const result = await service.answer({ question: '怎么省钱？', userId: 7, hints: {} })
  assert.deepEqual(result.sources, [12])
})
