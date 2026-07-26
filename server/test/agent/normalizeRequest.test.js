import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createNormalizeRequestNode,
  detectCompositeIntent
} from '../../src/agent/nodes/normalizeRequest.js'

test('detectCompositeIntent returns canonical deterministic finance intents', () => {
  const examples = [
    ['查本月收支，对比上月并告诉我怎么省钱', 'stat+analysis+suggest'],
    ['记一笔餐饮支出，再统计上月开销并给建议', 'record+stat+analysis+suggest'],
    ['昨天打车花了25元', 'record'],
    ['识别这张小票', 'ocr'],
    ['你好，今天心情怎么样？', 'chat']
  ]

  for (const [text, expected] of examples) {
    assert.equal(detectCompositeIntent(text), expected)
    assert.equal(detectCompositeIntent(text), expected)
  }
})

test('normalize request overwrites model-controlled identity with LangGraph config context', async () => {
  const messages = [{
    role: 'user',
    content: '查本月收支，对比上月并告诉我怎么省钱'
  }]
  const node = createNormalizeRequestNode({ now: () => 1785030000000 })
  const result = await node({
    messages,
    userId: 999,
    sessionId: 'model-session',
    isAdmin: true
  }, {
    context: {
      userId: 7,
      sessionId: 's-1',
      isAdmin: false,
      requestId: 'request-1',
      operationId: 'operation-1',
      deviceType: 'mobile',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      inputMode: 'text'
    }
  })

  assert.equal(result.userId, 7)
  assert.equal(result.sessionId, 's-1')
  assert.equal(result.isAdmin, false)
  assert.equal(result.intentType, 'stat+analysis+suggest')
  assert.equal(result.requestStartTime, 1785030000000)
  assert.equal(Object.hasOwn(result, 'messages'), false)
})

test('normalize request initializes safe defaults without replacing existing messages', async () => {
  const node = createNormalizeRequestNode({ now: () => 100 })
  const result = await node({
    messages: [{ role: 'user', content: '你好' }]
  }, {
    context: {
      userId: 7,
      sessionId: 's-1',
      isAdmin: false,
      deviceType: 'web',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      inputMode: 'text'
    }
  })

  assert.deepEqual(result.userMemory, [])
  assert.deepEqual(result.recentSummary, {})
  assert.deepEqual(result.datasetRefs, [])
  assert.equal(result.pendingConfirmation, null)
  assert.equal(result.toolCallCount, 0)
  assert.deepEqual(result.errors, [])
  assert.equal(result.response, null)
})

test('normalize request emits only whitelisted L1 session metadata', async () => {
  const node = createNormalizeRequestNode({ now: () => 200 })
  const result = await node({
    messages: [{ role: 'user', content: '你好' }],
    sessionMetadata: {
      userId: 999,
      isAdmin: true,
      authorization: 'Bearer secret',
      rawBody: { secret: true }
    }
  }, {
    context: {
      userId: 7,
      sessionId: 's-1',
      isAdmin: false,
      requestId: 'request-secret',
      operationId: 'operation-secret',
      deviceType: 'mobile',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      inputMode: 'voice',
      authorization: 'Bearer secret',
      rawBody: { secret: true }
    }
  })

  assert.deepEqual(result.sessionMetadata, {
    deviceType: 'mobile',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inputMode: 'voice',
    lastActiveAt: 200
  })
  assert.deepEqual(Object.keys(result.sessionMetadata), [
    'deviceType',
    'timezone',
    'locale',
    'inputMode',
    'lastActiveAt'
  ])
})

test('normalize request only reads trusted identity from config.context', async () => {
  const node = createNormalizeRequestNode({ now: () => 300 })

  await assert.rejects(
    node({
      messages: [{ role: 'user', content: '你好' }],
      userId: 999,
      sessionId: 'model-session',
      isAdmin: true
    }, {
      configurable: {
        userId: 7,
        sessionId: 'configurable-session',
        isAdmin: false
      }
    }),
    /runtime context/i
  )
})
