import test from 'node:test'
import assert from 'node:assert/strict'
import { StateSchema } from '@langchain/langgraph'
import {
  AgentState,
  INTENT_PARTS,
  IntentTypeSchema
} from '../../src/agent/state.js'
import {
  buildRuntimeContext,
  RuntimeContextValidationError
} from '../../src/agent/runtime.js'

const PUBLIC_STATE_FIELDS = [
  'messages',
  'userId',
  'sessionId',
  'sessionMetadata',
  'userMemory',
  'recentSummary',
  'datasetRefs',
  'pendingConfirmation',
  'toolCallCount',
  'errors',
  'response',
  'requestStartTime',
  'isAdmin',
  'intentType'
]

test('AgentState uses the LangGraph 1.4 StateSchema API with only approved public fields', () => {
  assert.equal(StateSchema.isInstance(AgentState), true)
  assert.deepEqual(AgentState.getChannelKeys(), PUBLIC_STATE_FIELDS)
})

test('AgentState channels initialize approved safe defaults', () => {
  const channels = AgentState.getChannels()

  assert.deepEqual(channels.messages.get(), [])
  assert.deepEqual(channels.sessionMetadata.get(), {})
  assert.deepEqual(channels.userMemory.get(), [])
  assert.deepEqual(channels.recentSummary.get(), {})
  assert.deepEqual(channels.datasetRefs.get(), [])
  assert.equal(channels.pendingConfirmation.get(), null)
  assert.equal(channels.toolCallCount.get(), 0)
  assert.deepEqual(channels.errors.get(), [])
  assert.equal(channels.response.get(), null)
  assert.equal(channels.isAdmin.get(), false)
  assert.equal(channels.intentType.get(), 'unknown')
})

test('AgentState accepts valid identity, time, and canonical composite intents', async () => {
  const input = {
    userId: 7,
    sessionId: 'session-7',
    requestStartTime: 0,
    intentType: 'record+query+stat+analysis+suggest+ocr'
  }

  assert.deepEqual(await AgentState.validateInput(input), input)
  assert.deepEqual(INTENT_PARTS, [
    'record',
    'query',
    'stat',
    'analysis',
    'suggest',
    'ocr',
    'chat',
    'unknown'
  ])
})

test('AgentState rejects invalid identity and request time values', async () => {
  await assert.rejects(
    AgentState.validateInput({ userId: 0 }),
    /Validation failed for field "userId"/
  )
  await assert.rejects(
    AgentState.validateInput({ userId: 1.5 }),
    /Validation failed for field "userId"/
  )
  await assert.rejects(
    AgentState.validateInput({ sessionId: '' }),
    /Validation failed for field "sessionId"/
  )
  await assert.rejects(
    AgentState.validateInput({ sessionId: 's'.repeat(129) }),
    /Validation failed for field "sessionId"/
  )
  await assert.rejects(
    AgentState.validateInput({ requestStartTime: -1 }),
    /Validation failed for field "requestStartTime"/
  )
})

test('IntentTypeSchema accepts unique allowed parts in any order or combination', () => {
  assert.equal(IntentTypeSchema.safeParse('suggest+stat').success, true)
  assert.equal(IntentTypeSchema.safeParse('chat+record').success, true)
  assert.equal(IntentTypeSchema.safeParse('unknown+analysis').success, true)
})

test('IntentTypeSchema rejects duplicate, empty, and unknown parts', () => {
  assert.equal(IntentTypeSchema.safeParse('record+record').success, false)
  assert.equal(IntentTypeSchema.safeParse('record+transfer').success, false)
  assert.equal(IntentTypeSchema.safeParse('record++stat').success, false)
  assert.equal(IntentTypeSchema.safeParse('+record').success, false)
  assert.equal(IntentTypeSchema.safeParse('').success, false)
})

test('buildRuntimeContext trusts server identity and ignores body spoofing', () => {
  const generatedIds = ['request-server-id', 'operation-server-id']
  const req = {
    body: {
      sessionId: '  body-session  ',
      userId: 999,
      isAdmin: true,
      requestId: 'body-request-id',
      operationId: 'body-operation-id',
      inputMode: 'voice'
    },
    headers: {
      'x-session-id': 'header-session',
      'x-request-id': 'header-request-id',
      'x-device-type': 'mobile',
      'x-timezone': 'Asia/Shanghai',
      'accept-language': 'zh-CN,en;q=0.8'
    },
    deviceId: 'device-session'
  }

  const context = buildRuntimeContext({
    req,
    userId: 7,
    isAdmin: false,
    randomId: () => generatedIds.shift()
  })

  assert.deepEqual(context, {
    userId: 7,
    sessionId: 'body-session',
    requestId: 'request-server-id',
    operationId: 'operation-server-id',
    isAdmin: false,
    deviceType: 'mobile',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inputMode: 'voice'
  })
  assert.equal(Object.isFrozen(context), true)
})

test('buildRuntimeContext uses a valid idempotency key and safely normalizes metadata', () => {
  const context = buildRuntimeContext({
    req: {
      body: { inputMode: 'model-controlled-value' },
      headers: {
        'x-session-id': ' session-from-header ',
        'x-idempotency-key': ' operation-from-client ',
        'x-device-type': 'untrusted-device',
        'x-timezone': '../../etc/passwd',
        'accept-language': 'not_a_locale'
      },
      deviceId: 'device-session'
    },
    userId: '8',
    isAdmin: true,
    randomId: () => 'request-server-id'
  })

  assert.deepEqual(context, {
    userId: 8,
    sessionId: 'session-from-header',
    requestId: 'request-server-id',
    operationId: 'operation-from-client',
    isAdmin: true,
    deviceType: 'unknown',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inputMode: 'text'
  })
})

test('buildRuntimeContext rejects invalid server identity and missing session safely', () => {
  assert.throws(
    () => buildRuntimeContext({ req: { body: {}, headers: {} }, userId: 0, isAdmin: false }),
    error => error instanceof RuntimeContextValidationError &&
      error.code === 'ERR_INVALID_RUNTIME_CONTEXT' &&
      error.statusCode === 400 &&
      error.expose === true
  )

  assert.throws(
    () => buildRuntimeContext({ req: { body: {}, headers: {} }, userId: 7, isAdmin: false }),
    error => error instanceof RuntimeContextValidationError &&
      error.code === 'ERR_INVALID_RUNTIME_CONTEXT' &&
      error.statusCode === 400 &&
      error.expose === true
  )
})

test('buildRuntimeContext rejects overlong session ids and regenerates invalid idempotency keys', () => {
  assert.throws(
    () => buildRuntimeContext({
      req: { body: { sessionId: 's'.repeat(129) }, headers: {} },
      userId: 7,
      isAdmin: false
    }),
    RuntimeContextValidationError
  )

  const generatedIds = ['request-id', 'operation-id']
  const context = buildRuntimeContext({
    req: {
      body: { sessionId: 'session-7' },
      headers: { 'x-idempotency-key': 'x'.repeat(65) }
    },
    userId: 7,
    isAdmin: false,
    randomId: () => generatedIds.shift()
  })

  assert.equal(context.operationId, 'operation-id')
})
