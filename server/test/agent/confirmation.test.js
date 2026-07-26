import test from 'node:test'
import assert from 'node:assert/strict'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { Command, MemorySaver } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'
import { createAgentGraph } from '../../src/agent/graph.js'
import {
  createOperationStore,
  hashOperation
} from '../../src/agent/stores/operationStore.js'

const runtime = Object.freeze({
  userId: 7,
  sessionId: 'confirmation-session',
  requestId: 'confirmation-request',
  operationId: 'confirmation-operation',
  isAdmin: false,
  deviceType: 'mobile',
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  inputMode: 'text'
})

function state(content = '请记账') {
  return {
    messages: [new HumanMessage(content)],
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    requestStartTime: 0
  }
}

function graphConfig(threadId, context = runtime) {
  return {
    configurable: { thread_id: threadId },
    context,
    recursionLimit: 30
  }
}

function toolCall(name, args, id = `${name}-call`) {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args, type: 'tool_call' }]
  })
}

function toolCalls(calls) {
  return new AIMessage({
    content: '',
    tool_calls: calls.map(call => ({ ...call, type: 'tool_call' }))
  })
}

function queuedModel(outputs, calls) {
  return {
    bindTools() {
      return {
        async invoke(messages) {
          calls.model += 1
          calls.modelMessages.push(messages)
          return outputs.shift()
        }
      }
    }
  }
}

function createWriteTool(name, calls, schema) {
  return tool(async (input, toolRuntime) => {
    calls.write += 1
    calls.inputs.push(structuredClone(input))
    calls.runtimeOperationIds.push(toolRuntime.context?.operationId)
    return { status: 'ok', toolName: name }
  }, {
    name,
    description: `${name} test tool`,
    schema
  })
}

function createFixture({
  outputs,
  tools,
  now = () => 1_000,
  amountThreshold = 10_000,
  confirmationTtlSeconds = 30,
  operationStore = createOperationStore(createFakeOperationDb())
}) {
  const calls = {
    model: 0,
    modelMessages: [],
    write: 0,
    inputs: [],
    runtimeOperationIds: []
  }
  const graph = createAgentGraph({
    model: queuedModel([...outputs], calls),
    tools: tools(calls),
    checkpointer: new MemorySaver(),
    config: {
      agent: {
        maxToolCalls: 8,
        amountThreshold,
        confirmationTtlSeconds
      }
    },
    confirmationNow: now,
    operationStore
  })
  return { graph, calls }
}

function createFakeOperationDb() {
  const rows = []
  return table => {
    assert.equal(table, 'agent_operations')
    let criteria = {}
    return {
      where(value) {
        criteria = { ...criteria, ...value }
        return this
      },
      async first() {
        return structuredClone(rows.find(row =>
          Object.entries(criteria).every(([key, value]) => row[key] === value)
        ))
      },
      async insert(row) {
        if (rows.some(item =>
          item.user_id === row.user_id && item.operation_id === row.operation_id
        )) {
          throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
        }
        rows.push(structuredClone(row))
        return [rows.length]
      },
      async update(changes) {
        let count = 0
        for (const row of rows) {
          if (Object.entries(criteria).every(([key, value]) => row[key] === value)) {
            Object.assign(row, structuredClone(changes))
            count += 1
          }
        }
        return count
      }
    }
  }
}

const recordSchema = z.object({
  amount: z.number().positive(),
  type: z.enum(['income', 'expense']).default('expense'),
  category: z.string().trim().min(1),
  description: z.string().optional(),
  currency: z.string().default('CNY')
})

test('high-value transaction persists normalized arguments and resumes exactly once', async () => {
  const normalizedArgs = {
    amount: 20_000,
    type: 'expense',
    category: '交通',
    description: 'private trip details',
    currency: 'CNY'
  }
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema)
    ],
    outputs: [toolCall('record_transaction', {
      amount: 20_000,
      category: ' 交通 ',
      description: 'private trip details'
    })]
  })
  const config = graphConfig('confirmation-high-value')

  const interrupted = await graph.invoke(state(), config)

  assert.equal(calls.model, 1)
  assert.equal(calls.write, 0)
  assert.equal(interrupted.__interrupt__[0].value.kind, 'financial_confirmation')
  assert.deepEqual(interrupted.__interrupt__[0].value.reasons, ['high_amount'])
  assert.equal(interrupted.__interrupt__[0].value.operationId, runtime.operationId)
  assert.equal(interrupted.__interrupt__[0].value.toolName, 'record_transaction')
  assert.equal(
    JSON.stringify(interrupted.__interrupt__[0].value.summary)
      .includes('private trip details'),
    false
  )
  assert.deepEqual(interrupted.pendingConfirmation, {
    toolName: 'record_transaction',
    args: normalizedArgs,
    operationId: runtime.operationId,
    argsHash: hashOperation(normalizedArgs),
    safeSummary: {
      amount: 20_000,
      type: 'expense',
      category: '交通',
      currency: 'CNY'
    },
    expiresAt: 31_000
  })

  const approved = await graph.invoke(
    new Command({ resume: { approved: true } }),
    config
  )
  await graph.invoke(new Command({ resume: { approved: true } }), config)

  assert.equal(approved.response.success, true)
  assert.equal(approved.response.message, '记账成功。')
  assert.equal(calls.model, 1)
  assert.equal(calls.write, 1)
  assert.deepEqual(calls.inputs, [normalizedArgs])
})

test('all sensitive write tools interrupt before execution', async t => {
  for (const name of [
    'update_budget',
    'confirm_user_memory',
    'delete_user_memory',
    'update_transaction'
  ]) {
    await t.test(name, async () => {
      const schema = z.object({ value: z.string().trim() })
      const { graph, calls } = createFixture({
        tools: fixtureCalls => [createWriteTool(name, fixtureCalls, schema)],
        outputs: [toolCall(name, { value: ' sensitive ' })]
      })

      const interrupted = await graph.invoke(
        state(`执行 ${name}`),
        graphConfig(`confirmation-${name}`)
      )

      assert.equal(calls.write, 0)
      assert.equal(interrupted.__interrupt__[0].value.toolName, name)
      assert.deepEqual(
        interrupted.__interrupt__[0].value.reasons,
        ['sensitive_write']
      )
      assert.deepEqual(interrupted.pendingConfirmation.args, {
        value: 'sensitive'
      })
    })
  }
})

test('low-value transaction executes without interrupting', async () => {
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema)
    ],
    outputs: [
      toolCall('record_transaction', { amount: 25, category: '餐饮' }),
      new AIMessage('已记账')
    ]
  })

  const result = await graph.invoke(
    state(),
    graphConfig('confirmation-low-value')
  )

  assert.equal(result.__interrupt__, undefined)
  assert.equal(result.response.success, true)
  assert.equal(result.response.message, '记账成功。')
  assert.equal(calls.model, 1)
  assert.equal(calls.write, 1)
  assert.deepEqual(calls.inputs[0], {
    amount: 25,
    type: 'expense',
    category: '餐饮',
    currency: 'CNY'
  })
})

test('rejected batch closes every tool call without executing tools', async () => {
  const queryCalls = []
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema),
      tool(async input => {
        queryCalls.push(structuredClone(input))
        return { datasetRef: 'should-not-run' }
      }, {
        name: 'query_transactions',
        description: 'query transactions',
        schema: z.object({ month: z.string() })
      })
    ],
    outputs: [
      toolCalls([
        {
          id: 'rejected-write',
          name: 'record_transaction',
          args: { amount: 20_000, category: '餐饮' }
        },
        {
          id: 'rejected-query',
          name: 'query_transactions',
          args: { month: '2026-07' }
        }
      ]),
      new AIMessage('下一轮正常')
    ]
  })
  const config = graphConfig('confirmation-rejected')
  await graph.invoke(state('更新并分析'), config)

  const result = await graph.invoke(
    new Command({ resume: { approved: false } }),
    config
  )
  const terminalMessages = result.messages.filter(message =>
    message._getType() === 'tool' &&
    ['rejected-write', 'rejected-query'].includes(message.tool_call_id)
  )

  assert.equal(calls.model, 1)
  assert.equal(calls.write, 0)
  assert.equal(queryCalls.length, 0)
  assert.equal(result.response.success, false)
  assert.match(result.response.message, /已取消，未执行/)
  assert.deepEqual(result.response.errorCodes, ['CONFIRMATION_REJECTED'])
  assert.deepEqual(
    terminalMessages.map(message => message.tool_call_id).sort(),
    ['rejected-query', 'rejected-write']
  )
  for (const message of terminalMessages) {
    assert.match(message.content, /CONFIRMATION_REJECTED/)
  }

  const nextTurn = await graph.invoke(state('继续'), config)

  assert.equal(calls.model, 2)
  assert.equal(nextTurn.response.success, true)
  assert.equal(nextTurn.response.message, '下一轮正常')
})

test('expired batch closes every tool call without executing tools', async () => {
  let currentTime = 1_000
  const queryCalls = []
  const { graph, calls } = createFixture({
    now: () => currentTime,
    confirmationTtlSeconds: 1,
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema),
      tool(async input => {
        queryCalls.push(structuredClone(input))
        return { datasetRef: 'should-not-run' }
      }, {
        name: 'query_transactions',
        description: 'query transactions',
        schema: z.object({ month: z.string() })
      })
    ],
    outputs: [
      toolCalls([
        {
          id: 'expired-write',
          name: 'record_transaction',
          args: { amount: 20_000, category: '餐饮' }
        },
        {
          id: 'expired-query',
          name: 'query_transactions',
          args: { month: '2026-07' }
        }
      ]),
      new AIMessage('过期后的下一轮正常')
    ]
  })
  const config = graphConfig('confirmation-expired')
  const interrupted = await graph.invoke(state('更新并分析'), config)
  currentTime = interrupted.pendingConfirmation.expiresAt + 1

  const result = await graph.invoke(
    new Command({ resume: { approved: true } }),
    config
  )
  const terminalMessages = result.messages.filter(message =>
    message._getType() === 'tool' &&
    ['expired-write', 'expired-query'].includes(message.tool_call_id)
  )

  assert.equal(calls.model, 1)
  assert.equal(calls.write, 0)
  assert.equal(queryCalls.length, 0)
  assert.equal(result.response.success, false)
  assert.match(result.response.message, /确认已过期，未执行/)
  assert.deepEqual(result.response.errorCodes, ['CONFIRMATION_EXPIRED'])
  assert.deepEqual(
    terminalMessages.map(message => message.tool_call_id).sort(),
    ['expired-query', 'expired-write']
  )
  for (const message of terminalMessages) {
    assert.match(message.content, /CONFIRMATION_EXPIRED/)
  }

  const nextTurn = await graph.invoke(state('继续'), config)

  assert.equal(calls.model, 2)
  assert.equal(nextTurn.response.success, true)
  assert.equal(nextTurn.response.message, '过期后的下一轮正常')
})

test('approved write can continue a mixed task with domain analysis tools', async () => {
  const querySchema = z.object({ month: z.string() })
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema),
      tool(async input => {
        calls.inputs.push(structuredClone(input))
        return { datasetRef: 'ds_after-write', count: 1, scope: input }
      }, {
        name: 'query_transactions',
        description: 'query after write',
        schema: querySchema
      })
    ],
    outputs: [
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' }),
      toolCall('query_transactions', { month: '2026-07' }),
      new AIMessage('记账并分析完成')
    ]
  })
  const config = graphConfig('confirmation-mixed')
  await graph.invoke(state('记账后分析'), config)

  const result = await graph.invoke(
    new Command({ resume: { approved: true } }),
    config
  )

  assert.equal(calls.write, 1)
  assert.equal(calls.model, 3)
  assert.equal(result.response.message, '记账并分析完成')
  assert.deepEqual(result.datasetRefs, [{
    datasetRef: 'ds_after-write',
    count: 1,
    scope: { month: '2026-07' }
  }])
})

test('pending confirmation rejects invalid operation ids before interrupting', async () => {
  const invalidRuntime = {
    ...runtime,
    operationId: 'invalid operation id'
  }
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema)
    ],
    outputs: [
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' })
    ]
  })

  const result = await graph.invoke(
    state(),
    graphConfig('confirmation-invalid-operation', invalidRuntime)
  )

  assert.equal(result.__interrupt__, undefined)
  assert.equal(calls.write, 0)
  assert.deepEqual(result.response.errorCodes, ['CONFIRMATION_STATE_INVALID'])
})

test('resume rejects changed persisted arguments and their stale hash', async () => {
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema)
    ],
    outputs: [
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' })
    ]
  })
  const config = graphConfig('confirmation-invalid-hash')
  const interrupted = await graph.invoke(state(), config)
  await graph.updateState(config, {
    pendingConfirmation: {
      ...interrupted.pendingConfirmation,
      args: {
        ...interrupted.pendingConfirmation.args,
        amount: 99_000
      }
    }
  })

  const result = await graph.invoke(
    new Command({ resume: { approved: true } }),
    config
  )

  assert.equal(calls.write, 0)
  assert.deepEqual(result.response.errorCodes, ['CONFIRMATION_STATE_INVALID'])
})

test('resume executes with the persisted operation id instead of the new request id', async () => {
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema)
    ],
    outputs: [
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' })
    ]
  })
  const initialConfig = graphConfig('confirmation-operation-binding')
  await graph.invoke(state(), initialConfig)

  await graph.invoke(
    new Command({ resume: { approved: true } }),
    graphConfig('confirmation-operation-binding', {
      ...runtime,
      operationId: 'resume-request-operation'
    })
  )

  assert.deepEqual(calls.runtimeOperationIds, [runtime.operationId])
})

test('concurrent duplicate resumes atomically claim one persisted write', async () => {
  const operationStore = createOperationStore(createFakeOperationDb())
  const { graph, calls } = createFixture({
    operationStore,
    tools: fixtureCalls => [
      tool(async input => {
        fixtureCalls.write += 1
        fixtureCalls.inputs.push(structuredClone(input))
        await new Promise(resolve => setTimeout(resolve, 25))
        return { status: 'ok' }
      }, {
        name: 'record_transaction',
        description: 'concurrent write test tool',
        schema: recordSchema
      })
    ],
    outputs: [
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' })
    ]
  })
  const config = graphConfig('confirmation-concurrent')
  await graph.invoke(state(), config)

  await Promise.all([
    graph.invoke(new Command({ resume: { approved: true } }), config),
    graph.invoke(new Command({ resume: { approved: true } }), config)
  ])

  assert.equal(calls.model, 1)
  assert.equal(calls.write, 1)
  assert.deepEqual(calls.inputs, [{
    amount: 20_000,
    type: 'expense',
    category: '餐饮',
    currency: 'CNY'
  }])
})

test('batched write and query resolves every call before the model retries the query', async () => {
  const queryCalls = []
  const { graph, calls } = createFixture({
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema),
      tool(async input => {
        queryCalls.push(structuredClone(input))
        return { datasetRef: 'ds_batch-query', count: 1, scope: input }
      }, {
        name: 'query_transactions',
        description: 'query after a batched write',
        schema: z.object({ month: z.string() })
      })
    ],
    outputs: [
      toolCalls([
        {
          id: 'batch-write',
          name: 'record_transaction',
          args: { amount: 20_000, category: '餐饮' }
        },
        {
          id: 'batch-query-skipped',
          name: 'query_transactions',
          args: { month: '2026-07' }
        }
      ]),
      toolCall(
        'query_transactions',
        { month: '2026-07' },
        'batch-query-retry'
      ),
      new AIMessage('批量任务完成')
    ]
  })
  const config = graphConfig('confirmation-batched-calls')
  await graph.invoke(state('记账后分析本月支出'), config)

  const result = await graph.invoke(
    new Command({ resume: { approved: true } }),
    config
  )
  const secondModelToolMessages = calls.modelMessages[1].filter(
    message => message._getType() === 'tool'
  )

  assert.equal(calls.write, 1)
  assert.deepEqual(queryCalls, [{ month: '2026-07' }])
  assert.deepEqual(
    secondModelToolMessages.map(message => message.tool_call_id).sort(),
    ['batch-query-skipped', 'batch-write']
  )
  assert.match(
    secondModelToolMessages.find(
      message => message.tool_call_id === 'batch-query-skipped'
    ).content,
    /TOOL_CALL_RETRY_REQUIRED/
  )
  assert.equal(result.response.message, '批量任务完成')
})

test('a thrown sensitive write fails the operation and is never replayed as success', async () => {
  const baseStore = createOperationStore(createFakeOperationDb())
  const storeCalls = { succeed: 0, fail: 0 }
  const operationStore = {
    claim: input => baseStore.claim(input),
    async succeed(input) {
      storeCalls.succeed += 1
      return baseStore.succeed(input)
    },
    async fail(input) {
      storeCalls.fail += 1
      return baseStore.fail(input)
    }
  }
  let writes = 0
  const createFailingTools = () => [
    tool(async () => {
      writes += 1
      throw new Error('database password=secret')
    }, {
      name: 'update_transaction',
      description: 'failing sensitive write',
      schema: z.object({ id: z.number().int().positive() })
    })
  ]

  const first = createFixture({
    operationStore,
    tools: createFailingTools,
    outputs: [toolCall('update_transaction', { id: 9 })]
  })
  const firstConfig = graphConfig('confirmation-failed-write')
  await first.graph.invoke(state('更新交易'), firstConfig)
  const firstResult = await first.graph.invoke(
    new Command({ resume: { approved: true } }),
    firstConfig
  )

  const retry = createFixture({
    operationStore,
    tools: createFailingTools,
    outputs: [toolCall('update_transaction', { id: 9 })]
  })
  const retryConfig = graphConfig('confirmation-failed-write-retry')
  await retry.graph.invoke(state('再次更新交易'), retryConfig)
  const retryResult = await retry.graph.invoke(
    new Command({ resume: { approved: true } }),
    retryConfig
  )

  assert.equal(writes, 1)
  assert.equal(storeCalls.succeed, 0)
  assert.equal(storeCalls.fail, 1)
  assert.equal(firstResult.response.success, false)
  assert.equal(retryResult.response.success, false)
  assert.deepEqual(firstResult.response.errorCodes, ['TOOL_EXECUTION_FAILED'])
  assert.doesNotMatch(JSON.stringify(firstResult), /password|secret/)
})

test('confirmation failures close every batched tool call with safe messages', async t => {
  const input = { id: 9 }
  const inputHash = hashOperation({
    operationType: 'update_transaction',
    input
  })
  for (const item of [
    {
      name: 'claim persistence',
      expectedCode: 'TOOL_EXECUTION_FAILED',
      claim: async () => { throw new Error('claim database secret') },
      toolThrows: false,
      succeed: async () => assert.fail('succeed must not run'),
      fail: async () => assert.fail('fail must not run')
    },
    {
      name: 'claim hash mismatch',
      expectedCode: 'CONFIRMATION_STATE_INVALID',
      claim: async () => ({
        status: 'owner',
        inputHash: 'a'.repeat(64)
      }),
      toolThrows: false,
      succeed: async () => assert.fail('succeed must not run'),
      fail: async () => assert.fail('fail must not run')
    },
    {
      name: 'succeed transition',
      expectedCode: 'TOOL_EXECUTION_FAILED',
      claim: async () => ({ status: 'owner', inputHash }),
      toolThrows: false,
      succeed: async () => { throw new Error('succeed database secret') },
      fail: async () => {}
    },
    {
      name: 'fail transition',
      expectedCode: 'TOOL_EXECUTION_FAILED',
      claim: async () => ({ status: 'owner', inputHash }),
      toolThrows: true,
      succeed: async () => assert.fail('succeed must not run'),
      fail: async () => { throw new Error('fail database secret') }
    }
  ]) {
    await t.test(item.name, async () => {
      let failCalls = 0
      const { graph } = createFixture({
        operationStore: {
          claim: item.claim,
          succeed: item.succeed,
          async fail(value) {
            failCalls += 1
            return item.fail(value)
          }
        },
        tools: () => [
          tool(async () => {
            if (item.toolThrows) throw new Error('tool database secret')
            return { status: 'ok' }
          }, {
            name: 'update_transaction',
            description: 'sensitive write transition test',
            schema: z.object({ id: z.number().int().positive() })
          }),
          tool(async () => ({ datasetRef: 'must-not-run' }), {
            name: 'query_transactions',
            description: 'batched query that must be safely resolved',
            schema: z.object({ month: z.string() })
          })
        ],
        outputs: [toolCalls([
          {
            id: `failure-write-${item.name}`,
            name: 'update_transaction',
            args: input
          },
          {
            id: `failure-query-${item.name}`,
            name: 'query_transactions',
            args: { month: '2026-07' }
          }
        ])]
      })
      const config = graphConfig(`confirmation-${item.name.replace(' ', '-')}`)
      await graph.invoke(state('更新并分析'), config)

      const result = await graph.invoke(
        new Command({ resume: { approved: true } }),
        config
      )
      const failureMessages = result.messages.filter(
        message => message._getType() === 'tool' &&
          message.tool_call_id?.startsWith('failure-')
      )

      assert.equal(result.response.success, false)
      assert.deepEqual(result.response.errorCodes, [item.expectedCode])
      assert.deepEqual(
        failureMessages.map(message => message.tool_call_id).sort(),
        [
          `failure-query-${item.name}`,
          `failure-write-${item.name}`
        ].sort()
      )
      assert.equal(
        failureMessages.every(message =>
          message.content.includes(item.expectedCode)
        ),
        true
      )
      assert.doesNotMatch(JSON.stringify(result), /database secret/)
      if (item.name === 'fail transition') assert.equal(failCalls, 1)
    })
  }
})
