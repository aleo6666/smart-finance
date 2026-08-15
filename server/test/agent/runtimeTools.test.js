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

function toolsByName(options) {
  return Object.fromEntries(
    createRuntimeTools(options).map(item => [item.name, item])
  )
}

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
    'analyze_financial_health',
    'plan_financial_goal',
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

test('analyze_financial_health is mounted and returns a structured health report', async () => {
  let written
  const tools = toolsByName({
    runtime,
    datasetStore: {
      async get() {
        return {
          rows: [],
          summary: {
            totalIncome: 15000,
            totalExpense: 9000,
            categoryStats: [
              { category: '餐饮', total: 3000 },
              { category: '交通', total: 1000 },
              { category: '住房', total: 3000 },
              { category: '娱乐', total: 1000 },
              { category: '其他', total: 1000 }
            ],
            budgets: [{ category: '餐饮', limit: 3500, spent: 3000 }],
            monthCount: 3,
            totalSavings: 30000
          },
          scope: { month: '2026-07' }
        }
      },
      async put(input) {
        written = input
        return { datasetRef: 'ds_health', count: 0, scope: input.scope }
      }
    },
    operationStore: {},
    memoryRepository: repository
  })

  const result = await tools.analyze_financial_health.invoke({
    datasetRef: 'ds_query',
    analysisType: 'full'
  })

  const health = written.summary.summary
  assert.equal(written.summary.source, 'financial_advisor')
  assert.ok(health.healthScore >= 0 && health.healthScore <= 100, 'healthScore 应在 0-100 之间')
  assert.ok(['优秀', '良好', '一般', '需关注'].includes(health.healthLabel))
  assert.equal(typeof health.savingsRate, 'number')
  assert.ok(Array.isArray(written.summary.recommendations))
  assert.equal(written.userId, 7)
  assert.equal(written.requestId, 'request-7')
  assert.deepEqual(result, {
    datasetRef: 'ds_health',
    count: 0,
    scope: { month: '2026-07' }
  })
})

test('analyze_financial_health returns DATASET_NOT_FOUND when the dataset is missing', async () => {
  let wrote = false
  const tools = toolsByName({
    runtime,
    datasetStore: {
      async get() {
        return null
      },
      async put() {
        wrote = true
      }
    },
    operationStore: {},
    memoryRepository: repository
  })

  const result = await tools.analyze_financial_health.invoke({
    datasetRef: 'ds_missing'
  })

  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'DATASET_NOT_FOUND')
  assert.equal(wrote, false)
})
