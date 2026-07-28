import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createObserveNode, buildObserveEvent } from '../../src/agent/nodes/observe.js'

function fixtureState(overrides = {}) {
  return {
    userId: overrides.userId ?? 7,
    sessionId: overrides.sessionId ?? 's-1',
    messages: overrides.messages ?? [
      { role: 'user', content: '查本月餐饮' },
      {
        role: 'assistant',
        content: '本月餐饮支出共 1,234.56 元。',
        tool_calls: [{ name: 'query_transactions' }]
      }
    ],
    response: overrides.response ?? {
      success: true,
      intent: 'query',
      message: '本月餐饮支出共 1,234.56 元。'
    },
    toolCallCount: overrides.toolCallCount ?? 1,
    requestStartTime: overrides.requestStartTime ?? Date.now(),
    errors: overrides.errors ?? [],
    ...overrides
  }
}

function fixtureRuntime(overrides = {}) {
  return {
    userId: overrides.userId ?? 7,
    sessionId: overrides.sessionId ?? 's-1',
    requestId: overrides.requestId ?? 'r-1',
    isAdmin: overrides.isAdmin ?? false,
    ...overrides
  }
}

describe('observe', () => {
  it('builds sanitized event without message content', () => {
    const event = buildObserveEvent(
      fixtureState({
        messages: [
          { role: 'user', content: '我的工资是8000' },
          {
            role: 'assistant',
            content: '好的，记下了每月收入8000元。',
            tool_calls: [{ name: 'propose_user_memory' }]
          }
        ]
      }),
      fixtureRuntime()
    )

    const serialized = JSON.stringify(event)
    // Event must not contain the raw user message content
    assert.doesNotMatch(serialized, /工资是8000/)
    assert.doesNotMatch(serialized, /收入8000/)
    // But metadata should be present
    assert.ok(Array.isArray(event.toolNames))
    assert.ok(event.toolNames.includes('propose_user_memory'))
    assert.equal(event.userId, 7)
  })

  it('excludes dataset rows and API keys from event', () => {
    const event = buildObserveEvent(
      fixtureState(),
      fixtureRuntime()
    )

    const serialized = JSON.stringify(event)
    assert.doesNotMatch(serialized, /\bsecret\b/i)
    assert.doesNotMatch(serialized, /\bapiKey\b/i)
    assert.doesNotMatch(serialized, /\bpassword\b/i)
  })

  it('records degraded flag when memory errors present', () => {
    const event = buildObserveEvent(
      fixtureState({
        errors: [
          { code: 'MEMORY_LOAD_FAILED', degraded: true },
          { code: 'SUMMARY_UPDATE_FAILED', degraded: true }
        ]
      }),
      fixtureRuntime()
    )

    assert.equal(event.degraded, true)
    assert.deepEqual(event.errorCodes, ['MEMORY_LOAD_FAILED', 'SUMMARY_UPDATE_FAILED'])
    assert.equal(event.success, false)
  })

  it('reports success when no errors', () => {
    const event = buildObserveEvent(fixtureState(), fixtureRuntime())

    assert.equal(event.success, true)
    assert.deepEqual(event.errorCodes, [])
    assert.equal(event.degraded, false)
  })

  it('calls recordAgentEvent and never throws', async () => {
    const calls = []
    const node = createObserveNode({
      recordAgentEvent: async (event) => {
        calls.push(event)
      }
    })

    await node(fixtureState(), { context: fixtureRuntime() })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].userId, 7)
    assert.equal(calls[0].success, true)
  })

  it('swallows record failures without throwing', async () => {
    const node = createObserveNode({
      recordAgentEvent: async () => {
        throw new Error('DB unavailable')
      }
    })

    // Must not throw
    const result = await node(fixtureState(), { context: fixtureRuntime() })
    assert.deepEqual(result, {})
  })

  it('computes latency from requestStartTime', () => {
    const start = Date.now() - 500
    const event = buildObserveEvent(
      fixtureState({ requestStartTime: start }),
      fixtureRuntime()
    )

    assert.ok(event.latencyMs >= 500, `latency ${event.latencyMs} should be >= 500`)
    assert.ok(event.latencyMs < 5000, `latency ${event.latencyMs} should be less than 5000`)
  })
})
