import test from 'node:test'
import assert from 'node:assert/strict'
import { FINANCE_SYSTEM_RULES } from '../../src/agent/prompts.js'
import { createRuntimeTools } from '../../src/agent/tools/runtimeTools.js'

const runtime = Object.freeze({
  userId: 7,
  sessionId: 'session-7',
  requestId: 'request-7',
  operationId: 'operation-7'
})

const repository = Object.freeze({
  async get() {},
  async propose() {},
  async update() {},
  async confirm() {},
  async softDelete() {}
})

test('runtime tools include the memory tools advertised to the model', () => {
  const names = createRuntimeTools({
    runtime,
    datasetStore: {},
    operationStore: {},
    memoryRepository: repository
  }).map(item => item.name)

  assert.deepEqual(new Set(names), new Set([
    'query_transactions',
    'calculate_finance_metrics',
    'check_budget',
    'record_transaction',
    'get_user_memory',
    'propose_user_memory',
    'update_user_memory',
    'confirm_user_memory',
    'delete_user_memory'
  ]))
})

test('system prompt does not advertise tools that are not runtime-bound', () => {
  assert.equal(FINANCE_SYSTEM_RULES.includes('search_knowledge_base'), false)
  assert.equal(FINANCE_SYSTEM_RULES.includes('ocr_receipt'), false)
})
