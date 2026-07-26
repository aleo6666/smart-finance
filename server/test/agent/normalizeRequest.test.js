import test from 'node:test'
import assert from 'node:assert/strict'
import { HumanMessage } from '@langchain/core/messages'
import { END, START, StateGraph } from '@langchain/langgraph'
import { AgentState } from '../../src/agent/state.js'
import { RuntimeContextValidationError } from '../../src/agent/runtime.js'
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

test('detectCompositeIntent recognizes amount-bearing record phrases', () => {
  for (const text of ['收入5000', '支出50', '收入 5000元', '花了25元']) {
    assert.equal(detectCompositeIntent(text), 'record')
  }
})

test('detectCompositeIntent does not treat the bare character 查 as a query', () => {
  assert.equal(detectCompositeIntent('调查省钱方法'), 'suggest')
})

test('detectCompositeIntent recognizes bounded finance query phrases', () => {
  for (const text of ['查一下本月账单', '查下账单', '查一下明细']) {
    assert.equal(detectCompositeIntent(text), 'query')
  }
})

test('detectCompositeIntent recognizes an amount-less categorized record clarification', () => {
  assert.equal(detectCompositeIntent('昨天有一笔餐饮支出'), 'record')
})

test('detectCompositeIntent ignores a negated categorized record phrase', () => {
  assert.equal(detectCompositeIntent('这个月没有一笔餐饮支出'), 'chat')
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

test('normalize request drops request-scoped dataset references from a previous turn', async () => {
  const node = createNormalizeRequestNode({ now: () => 300 })
  const result = await node({
    messages: [new HumanMessage('分析本月开销')],
    datasetRefs: [{ datasetRef: 'ds_previous_request' }]
  }, {
    context: {
      userId: 7,
      sessionId: 'session-7'
    }
  })

  assert.deepEqual(result.datasetRefs, [])
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

test('normalize request never infers intent from assistant or tool messages', async () => {
  const node = createNormalizeRequestNode({ now: () => 400 })
  const result = await node({
    messages: [
      { role: 'assistant', content: '昨天打车花了25元' },
      { role: 'tool', content: '昨天打车花了25元' }
    ]
  }, {
    context: {
      userId: 7,
      sessionId: 's-1',
      isAdmin: false
    }
  })

  assert.equal(result.intentType, 'chat')
})

test('normalize request rejects boolean runtime user identity', async () => {
  const node = createNormalizeRequestNode({ now: () => 500 })

  await assert.rejects(
    node({
      messages: [{ role: 'user', content: '你好' }]
    }, {
      context: {
        userId: true,
        sessionId: 's-1',
        isAdmin: false
      }
    }),
    /positive integer/i
  )
})

test('normalize request rejects an unsafe runtime session id with the shared safe error', async () => {
  const node = createNormalizeRequestNode({ now: () => 550 })

  await assert.rejects(
    node({
      messages: [{ role: 'user', content: '你好' }]
    }, {
      context: {
        userId: 7,
        sessionId: 'bad/session',
        isAdmin: false
      }
    }),
    error => error instanceof RuntimeContextValidationError &&
      error.code === 'ERR_INVALID_RUNTIME_CONTEXT' &&
      error.statusCode === 400 &&
      error.expose === true &&
      /sessionId/.test(error.message)
  )
})

test('compiled StateGraph normalizes HumanMessage while preserving trusted identity', async () => {
  const normalizeRequest = createNormalizeRequestNode({ now: () => 600 })
  const graph = new StateGraph(AgentState)
    .addNode('normalize_request', normalizeRequest)
    .addEdge(START, 'normalize_request')
    .addEdge('normalize_request', END)
    .compile()

  const result = await graph.invoke({
    messages: [new HumanMessage('收入5000')],
    userId: 999,
    sessionId: 'model-session',
    requestStartTime: 0,
    isAdmin: true
  }, {
    context: {
      userId: 7,
      sessionId: 'trusted-session',
      isAdmin: false,
      deviceType: 'mobile',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      inputMode: 'text'
    }
  })

  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0] instanceof HumanMessage, true)
  assert.equal(result.messages[0].content, '收入5000')
  assert.equal(result.userId, 7)
  assert.equal(result.sessionId, 'trusted-session')
  assert.equal(result.isAdmin, false)
  assert.equal(result.intentType, 'record')
})
