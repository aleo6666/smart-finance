import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createAgentService, inRollout } from '../../src/agent/service.js'

function fixtureConfig(overrides = {}) {
  return {
    agent: {
      enabled: overrides.enabled ?? true,
      rolloutPercent: overrides.rolloutPercent ?? 100,
      recursionLimit: overrides.recursionLimit ?? 12,
      ...overrides
    },
    ...overrides._rest
  }
}

function fixtureState(overrides = {}) {
  return {
    messages: overrides.messages ?? [{ role: 'user', content: '查本月餐饮' }],
    intentType: overrides.intentType ?? 'query',
    ...overrides
  }
}

function fixtureRuntime(overrides = {}) {
  return {
    userId: overrides.userId ?? 7,
    sessionId: overrides.sessionId ?? 's-1',
    requestId: overrides.requestId ?? 'r-1',
    isAdmin: overrides.isAdmin ?? false,
    deviceType: overrides.deviceType ?? 'mobile',
    timezone: overrides.timezone ?? 'Asia/Shanghai',
    locale: overrides.locale ?? 'zh-CN',
    inputMode: overrides.inputMode ?? 'text',
    ...overrides
  }
}

describe('inRollout', () => {
  it('always returns true at 100%', () => {
    for (const userId of [1, 7, 42, 999]) {
      assert.equal(inRollout(userId, 100), true)
    }
  })

  it('always returns false at 0%', () => {
    for (const userId of [1, 7, 42, 999]) {
      assert.equal(inRollout(userId, 0), false)
    }
  })

  it('is stable per user at intermediate percent', () => {
    const first = inRollout(7, 25)
    const second = inRollout(7, 25)
    assert.equal(first, second)
  })
})

describe('createAgentService', () => {
  it('calls legacy when feature is off', async () => {
    let legacyCalled = false
    const service = createAgentService({
      config: fixtureConfig({ enabled: false, rolloutPercent: 100 }),
      graph: {
        invoke: async () => assert.fail('graph must not be called')
      },
      legacy: async () => {
        legacyCalled = true
        return { success: true, data: { intent: 'query', message: 'legacy', source: 'legacy' } }
      }
    })

    const result = await service.handle(fixtureState(), fixtureRuntime())
    assert.equal(legacyCalled, true)
    assert.equal(result.data.source, 'legacy')
  })

  it('calls legacy when user not in rollout bucket', async () => {
    let legacyCalled = false
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 0 }),
      graph: {
        invoke: async () => assert.fail('graph must not be called')
      },
      legacy: async () => {
        legacyCalled = true
        return { success: true, data: { intent: 'query', message: 'legacy', source: 'legacy' } }
      }
    })

    await service.handle(fixtureState(), fixtureRuntime({ userId: 7 }))
    assert.equal(legacyCalled, true)
  })

  it('calls graph when feature is on and user in bucket', async () => {
    let graphCalled = false
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      graph: {
        invoke: async (state, invocationConfig) => {
          graphCalled = true
          assert.equal(invocationConfig.configurable.thread_id, '7:s-1')
          return {
            response: {
              success: true,
              intent: 'query',
              message: '本月餐饮共 1,234.56 元'
            }
          }
        }
      },
      legacy: async () => assert.fail('legacy must not be called')
    })

    const result = await service.handle(fixtureState(), fixtureRuntime())
    assert.equal(graphCalled, true)
    assert.equal(result.data.message, '本月餐饮共 1,234.56 元')
    assert.equal(result.data.source, 'langgraph')
  })

  it('creates a runtime-bound graph for enabled requests when a factory is supplied', async () => {
    const runtimes = []
    let graphCalled = false
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      createGraph: runtime => {
        runtimes.push(runtime)
        return {
          invoke: async (_state, invocationConfig) => {
            graphCalled = true
            assert.equal(invocationConfig.context.currentLedgerId, 1)
            return {
              response: {
                success: true,
                intent: 'record',
                message: '记账成功。'
              }
            }
          }
        }
      },
      legacy: async () => assert.fail('legacy must not be called')
    })

    const runtime = fixtureRuntime({ currentLedgerId: 1 })
    const result = await service.handle(
      fixtureState({ intentType: 'record' }),
      runtime
    )

    assert.deepEqual(runtimes, [runtime])
    assert.equal(graphCalled, true)
    assert.equal(result.data.message, '记账成功。')
  })

  it('resets checkpointed volatile state before invoking a new user request', async () => {
    let receivedState
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      graph: {
        invoke: async state => {
          receivedState = state
          return {
            response: {
              success: true,
              intent: 'record',
              message: '记账成功。'
            }
          }
        }
      },
      legacy: async () => assert.fail('legacy must not be called')
    })

    await service.handle(fixtureState({
      intentType: 'record',
      pendingConfirmation: { toolName: 'record_transaction' },
      toolCallCount: 99,
      errors: [{ code: 'TOOL_CALL_LIMIT', fatal: true }],
      response: { success: false },
      datasetRefs: [{ datasetRef: 'ds_previous' }]
    }), fixtureRuntime())

    assert.equal(receivedState.pendingConfirmation, null)
    assert.equal(receivedState.toolCallCount, 0)
    assert.deepEqual(receivedState.errors, [])
    assert.equal(receivedState.response, null)
    assert.deepEqual(receivedState.datasetRefs, [])
  })

  it('returns manual record form on write-intent graph failure', async () => {
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      graph: {
        invoke: async () => { throw new Error('timeout') }
      },
      legacy: async () => assert.fail('must not call legacy for write intent')
    })

    const result = await service.handle(
      fixtureState({ intentType: 'record' }),
      fixtureRuntime()
    )

    assert.equal(result.success, true)
    assert.ok(result.data.message.includes('手动记账'))
    assert.equal(result.data.fallback.type, 'manual_record_form')
    assert.equal(result.data.source, 'langgraph_fallback')
  })

  it('falls back to legacy when a record graph returns retryable validation failure', async () => {
    let legacyCalled = false
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      graph: {
        invoke: async () => ({
          response: {
            success: false,
            intent: 'record',
            message: '请求无法安全执行，请调整后重试。',
            errorCodes: ['INVALID_TOOL_ARGUMENTS']
          }
        })
      },
      legacy: async () => {
        legacyCalled = true
        return {
          success: true,
          data: {
            intent: 'record',
            message: 'legacy recorded',
            source: 'legacy'
          }
        }
      }
    })

    const result = await service.handle(
      fixtureState({ intentType: 'record' }),
      fixtureRuntime()
    )

    assert.equal(legacyCalled, true)
    assert.equal(result.success, true)
    assert.equal(result.data.source, 'legacy')
    assert.equal(result.data.message, 'legacy recorded')
  })

  it('does not fall back to legacy for trusted-argument record rejection', async () => {
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      graph: {
        invoke: async () => ({
          response: {
            success: false,
            intent: 'record',
            message: '请求无法安全执行，请调整后重试。',
            errorCodes: ['TRUSTED_ARGUMENT_REJECTED']
          }
        })
      },
      legacy: async () => assert.fail('trusted argument rejection must not use legacy')
    })

    const result = await service.handle(
      fixtureState({ intentType: 'record' }),
      fixtureRuntime()
    )

    assert.equal(result.success, false)
    assert.equal(result.data.source, 'langgraph')
    assert.deepEqual(result.data.errorCodes, ['TRUSTED_ARGUMENT_REJECTED'])
  })

  it('calls legacy on non-write graph failure', async () => {
    let legacyCalled = false
    const service = createAgentService({
      config: fixtureConfig({ enabled: true, rolloutPercent: 100 }),
      graph: {
        invoke: async () => { throw new Error('timeout') }
      },
      legacy: async () => {
        legacyCalled = true
        return { success: true, data: { intent: 'chat', message: 'fallback', source: 'legacy' } }
      }
    })

    const result = await service.handle(
      fixtureState({ intentType: 'query' }),
      fixtureRuntime()
    )

    assert.equal(legacyCalled, true)
    assert.equal(result.data.source, 'legacy')
  })
})
