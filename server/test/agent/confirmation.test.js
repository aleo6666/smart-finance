import test from 'node:test'
import assert from 'node:assert/strict'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { Command, MemorySaver } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'
import { createAgentGraph } from '../../src/agent/graph.js'
import { hashOperation } from '../../src/agent/stores/operationStore.js'

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

function graphConfig(threadId) {
  return {
    configurable: { thread_id: threadId },
    context: runtime,
    recursionLimit: 30
  }
}

function toolCall(name, args, id = `${name}-call`) {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args, type: 'tool_call' }]
  })
}

function queuedModel(outputs, calls) {
  return {
    bindTools() {
      return {
        async invoke() {
          calls.model += 1
          return outputs.shift()
        }
      }
    }
  }
}

function createWriteTool(name, calls, schema) {
  return tool(async input => {
    calls.write += 1
    calls.inputs.push(structuredClone(input))
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
  confirmationTtlSeconds = 30
}) {
  const calls = { model: 0, write: 0, inputs: [] }
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
    confirmationNow: now
  })
  return { graph, calls }
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
  assert.equal(calls.model, 1)
  assert.equal(calls.write, 1)
  assert.deepEqual(calls.inputs[0], {
    amount: 25,
    type: 'expense',
    category: '餐饮',
    currency: 'CNY'
  })
})

test('rejected confirmation finalizes without executing the write', async () => {
  const finalized = []
  const calls = { model: 0, write: 0, inputs: [] }
  const graph = createAgentGraph({
    model: queuedModel([
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' })
    ], calls),
    tools: [createWriteTool('record_transaction', calls, recordSchema)],
    checkpointer: new MemorySaver(),
    config: {
      agent: {
        maxToolCalls: 8,
        amountThreshold: 10_000,
        confirmationTtlSeconds: 30
      }
    },
    confirmationNow: () => 1_000,
    finalizeResponse: async current => {
      finalized.push(current.pendingConfirmation)
      return { response: { success: false, message: 'cancelled' } }
    }
  })
  const config = graphConfig('confirmation-rejected')
  await graph.invoke(state(), config)

  const result = await graph.invoke(
    new Command({ resume: { approved: false } }),
    config
  )

  assert.equal(calls.model, 1)
  assert.equal(calls.write, 0)
  assert.equal(finalized.length, 1)
  assert.equal(result.response.message, 'cancelled')
})

test('expired confirmation returns CONFIRMATION_EXPIRED without executing the write', async () => {
  let currentTime = 1_000
  const { graph, calls } = createFixture({
    now: () => currentTime,
    confirmationTtlSeconds: 1,
    tools: fixtureCalls => [
      createWriteTool('record_transaction', fixtureCalls, recordSchema)
    ],
    outputs: [
      toolCall('record_transaction', { amount: 20_000, category: '餐饮' })
    ]
  })
  const config = graphConfig('confirmation-expired')
  const interrupted = await graph.invoke(state(), config)
  currentTime = interrupted.pendingConfirmation.expiresAt + 1

  const result = await graph.invoke(
    new Command({ resume: { approved: true } }),
    config
  )

  assert.equal(calls.model, 1)
  assert.equal(calls.write, 0)
  assert.equal(result.response.success, false)
  assert.deepEqual(result.response.errorCodes, ['CONFIRMATION_EXPIRED'])
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
