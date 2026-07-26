import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryTools } from '../../src/agent/tools/memoryTools.js'

const TRUSTED_FIELDS = [
  'userId',
  'sessionId',
  'isAdmin',
  'operationId',
  'sensitivity',
  'status',
  'sourceType'
]

test('memory tool schemas expose only business fields', () => {
  const tools = createMemoryTools({
    repository: {},
    runtime: {
      userId: 7,
      sessionId: 'trusted-session',
      operationId: 'trusted-operation'
    }
  })
  assert.deepEqual(
    tools.map(item => item.name).sort(),
    [
      'confirm_user_memory',
      'delete_user_memory',
      'get_user_memory',
      'propose_user_memory',
      'update_user_memory'
    ]
  )
  for (const item of tools) {
    const keys = Object.keys(item.schema.shape)
    for (const field of TRUSTED_FIELDS) assert.equal(keys.includes(field), false)
  }
})

test('memory tools inject trusted runtime values and return redacted metadata', async () => {
  const calls = []
  const repository = {
    async propose(input) {
      calls.push(['propose', input])
      return {
        namespace: input.namespace,
        memoryKey: input.memoryKey,
        value: input.value,
        sensitivity: 'sensitive',
        status: 'pending',
        version: 1
      }
    },
    async update(input) {
      calls.push(['update', input])
      return { ...input, sensitivity: 'normal', status: 'active', version: 2 }
    },
    async confirm(input) {
      calls.push(['confirm', input])
      return { ...input, sensitivity: 'sensitive', status: 'active', version: 2 }
    },
    async softDelete(input) {
      calls.push(['delete', input])
      return { ...input, sensitivity: 'sensitive', status: 'deleted', version: 3 }
    },
    async get(userId, namespace, memoryKey) {
      calls.push(['get', { userId, namespace, memoryKey }])
      return {
        namespace,
        memoryKey,
        value: { secret: 'do-not-return' },
        sensitivity: 'sensitive',
        status: 'active',
        version: 2
      }
    }
  }
  const tools = createMemoryTools({
    repository,
    runtime: {
      userId: 7,
      sessionId: 'trusted-session',
      operationId: 'trusted-operation'
    }
  })
  const byName = Object.fromEntries(tools.map(item => [item.name, item]))
  const proposed = await byName.propose_user_memory.invoke({
    namespace: 'finance',
    memoryKey: 'monthly_income',
    value: { amount: 8000 },
    userId: 999,
    sessionId: 'attacker',
    operationId: 'attacker',
    status: 'active',
    sensitivity: 'normal'
  })
  assert.deepEqual(calls[0], ['propose', {
    namespace: 'finance',
    memoryKey: 'monthly_income',
    value: { amount: 8000 },
    userId: 7,
    sessionId: 'trusted-session',
    operationId: 'trusted-operation'
  }])
  assert.equal(JSON.stringify(proposed).includes('8000'), false)
  assert.equal(proposed.status, 'pending')

  await byName.update_user_memory.invoke({
    namespace: 'preferences',
    memoryKey: 'response_style',
    value: { style: 'concise' },
    expectedVersion: 1
  })
  await byName.confirm_user_memory.invoke({
    namespace: 'finance',
    memoryKey: 'monthly_income',
    expectedVersion: 1
  })
  await byName.delete_user_memory.invoke({
    namespace: 'finance',
    memoryKey: 'monthly_income',
    expectedVersion: 2
  })
  const fetched = await byName.get_user_memory.invoke({
    namespace: 'finance',
    memoryKey: 'monthly_income'
  })

  for (const [, input] of calls.slice(1, 4)) {
    assert.equal(input.userId, 7)
    assert.equal(input.operationId, 'trusted-operation')
  }
  assert.equal(calls[1][1].sessionId, 'trusted-session')
  assert.equal(JSON.stringify(fetched).includes('do-not-return'), false)
})
