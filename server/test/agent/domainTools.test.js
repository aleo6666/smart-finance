import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkBudgetWithExistingServices,
  createDomainTools,
  queryFinanceDateRange
} from '../../src/agent/tools/domainTools.js'
import { CALCULATION_TYPES } from '../../src/services/calculatorAgent.js'

function toolsByName(options) {
  return Object.fromEntries(
    createDomainTools(options).map(item => [item.name, item])
  )
}

test('query tool delegates to existing SQL query with the trusted runtime user', async () => {
  const calls = []
  const tools = toolsByName({
    runtime: {
      userId: 7,
      requestId: 'request-1',
      operationId: 'operation-1'
    },
    queryFinanceSummary: async input => {
      calls.push(input)
      return { count: 1, total: 25, records: [{ amount: 25 }] }
    },
    datasetStore: {
      async put(input) {
        calls.push(input)
        return { datasetRef: 'ds-1', count: 1, scope: input.scope }
      }
    },
    executeCalculation: async () => ({}),
    checkBudget: async () => ({}),
    recordFromPlannerTask: async () => ({}),
    operationStore: {}
  })

  const result = await tools.query_transactions.invoke({
    month: '2026-07',
    category: '餐饮',
    userId: 999,
    requestId: 'attacker'
  })

  assert.equal(calls[0].userId, 7)
  assert.equal(calls[0].hints.month, '2026-07')
  assert.equal(calls[1].userId, 7)
  assert.equal(calls[1].requestId, 'request-1')
  assert.deepEqual(calls[1].summary, {
    count: 1,
    total: 25,
    records: [{ amount: 25 }]
  })
  assert.deepEqual(result, {
    datasetRef: 'ds-1',
    count: 1,
    scope: { month: '2026-07', category: '餐饮', queryKind: 'summary' }
  })
})

test('record tool lets only an idempotency owner call the existing recorder', async () => {
  const recorderCalls = []
  const tools = toolsByName({
    runtime: {
      userId: 7,
      requestId: 'request-1',
      operationId: 'operation-1'
    },
    queryFinanceSummary: async () => ({}),
    datasetStore: {},
    executeCalculation: async () => ({}),
    checkBudget: async () => ({}),
    recordFromPlannerTask: async input => {
      recorderCalls.push(input)
      return { recordIds: [8] }
    },
    operationStore: {
      async claim() {
        return { status: 'owner', inputHash: 'hash-1' }
      },
      async succeed() {},
      async fail() {}
    }
  })

  await tools.record_transaction.invoke({
    amount: 25,
    type: 'expense',
    category: '交通',
    date: '2026-07-25',
    userId: 999,
    operationId: 'attacker',
    deviceId: 'attacker'
  })

  assert.equal(recorderCalls.length, 1)
  assert.equal(recorderCalls[0].task.payload.userId, 7)
  assert.equal(recorderCalls[0].task.payload.deviceId, 'user-7')
})

test('domain tool schemas never expose trusted runtime or raw calculation data', () => {
  const tools = createDomainTools({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    datasetStore: {},
    operationStore: {}
  })
  const forbidden = [
    'userId',
    'sessionId',
    'requestId',
    'operationId',
    'isAdmin',
    'deviceId',
    'records',
    'rows',
    'amounts'
  ]
  for (const item of tools) {
    const fields = Object.keys(item.schema.shape)
    for (const field of forbidden) assert.equal(fields.includes(field), false)
  }
})

test('calculation reads the scoped dataset and delegates to the existing calculator', async () => {
  const calls = []
  const tools = toolsByName({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    queryFinanceSummary: async () => ({}),
    datasetStore: {
      async get(input) {
        calls.push(input)
        return {
          rows: [{ category: '餐饮', total: 75, count: 3 }],
          summary: {},
          scope: { month: '2026-07' }
        }
      }
    },
    executeCalculation: async task => (calls.push(task), { success: true }),
    checkBudget: async () => ({}),
    recordFromPlannerTask: async () => ({}),
    operationStore: {}
  })

  const result = await tools.calculate_finance_metrics.invoke({
    datasetRef: 'ds_valid',
    calculationType: CALCULATION_TYPES.CATEGORY_RATIO,
    userId: 999,
    requestId: 'attacker',
    records: [{ total: 999999 }]
  })
  assert.deepEqual(calls[0], {
    userId: 7,
    requestId: 'request-1',
    datasetRef: 'ds_valid'
  })
  assert.deepEqual(calls[1], {
    type: CALCULATION_TYPES.CATEGORY_RATIO,
    params: {
      categoryStats: [{ category: '餐饮', total: 75, count: 3 }]
    }
  })
  assert.deepEqual(result, { success: true })
})

test('budget tool injects the trusted user and returns structured checker output', async () => {
  const calls = []
  const tools = toolsByName({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    queryFinanceSummary: async () => ({}),
    datasetStore: {},
    executeCalculation: async () => ({}),
    checkBudget: async input => (calls.push(input), { status: 'warning', percent: 85 }),
    recordFromPlannerTask: async () => ({}),
    operationStore: {}
  })
  assert.deepEqual(await tools.check_budget.invoke({
    month: '2026-07',
    category: '餐饮',
    userId: 999
  }), { status: 'warning', percent: 85 })
  assert.deepEqual(calls[0], {
    userId: 7,
    month: '2026-07',
    category: '餐饮'
  })
})

test('record replay and in-progress claims never call the recorder', async () => {
  for (const [claim, expected] of [
    [{ status: 'succeeded', result: { recordIds: [8] } }, { recordIds: [8] }],
    [{ status: 'in_progress' }, { status: 'in_progress' }]
  ]) {
    let recorderCalls = 0
    const tools = toolsByName({
      runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
      queryFinanceSummary: async () => ({}),
      datasetStore: {},
      executeCalculation: async () => ({}),
      checkBudget: async () => ({}),
      recordFromPlannerTask: async () => { recorderCalls += 1 },
      operationStore: { async claim() { return claim } }
    })
    assert.deepEqual(await tools.record_transaction.invoke({
      amount: 25,
      category: '交通'
    }), expected)
    assert.equal(recorderCalls, 0)
  }
})

test('record failure marks the owned operation failed and exposes no internal error', async () => {
  const calls = []
  const tools = toolsByName({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    queryFinanceSummary: async () => ({}),
    datasetStore: {},
    executeCalculation: async () => ({}),
    checkBudget: async () => ({}),
    recordFromPlannerTask: async () => {
      throw new Error('database password appeared here')
    },
    operationStore: {
      async claim() { return { status: 'owner', inputHash: 'hash-1' } },
      async succeed() {},
      async fail(input) { calls.push(input) }
    }
  })
  await assert.rejects(
    tools.record_transaction.invoke({ amount: 25, category: '交通' }),
    error =>
      error.code === 'RECORD_TRANSACTION_FAILED' &&
      !error.message.includes('password')
  )
  assert.deepEqual(calls[0], {
    userId: 7,
    operationId: 'operation-1',
    inputHash: 'hash-1',
    errorCode: 'RECORD_TRANSACTION_FAILED'
  })
})

test('budget adapter composes existing retrieval and deterministic calculator functions', async () => {
  const calls = []
  const result = await checkBudgetWithExistingServices({
    userId: 7,
    month: '2026-07',
    category: '餐饮',
    retrieveBudgetConfig: async input => {
      calls.push(['budgets', input])
      return {
        success: true,
        data: {
          budgets: [
            { category: '餐饮', amount: 1000 },
            { category: '交通', amount: 300 }
          ]
        }
      }
    },
    retrieveCategoryStats: async input => {
      calls.push(['stats', input])
      return {
        success: true,
        data: {
          stats: [
            { category: '餐饮', total: 850 },
            { category: '交通', total: 100 }
          ]
        }
      }
    },
    calculateBudgetExecution: input => {
      calls.push(['calculate', input])
      return { success: true, data: { warningCategories: ['餐饮'] } }
    }
  })
  assert.deepEqual(calls, [
    ['budgets', { userId: 7, month: '2026-07' }],
    ['stats', { userId: 7, month: '2026-07' }],
    ['calculate', {
      budgets: [{ category: '餐饮', amount: 1000 }],
      categoryStats: [{ category: '餐饮', total: 850 }],
      totalSpending: 850,
      month: '2026-07'
    }]
  ])
  assert.deepEqual(result, {
    success: true,
    data: { warningCategories: ['餐饮'] }
  })
})

test('budget adapter safely rejects failed existing retrievals', async () => {
  await assert.rejects(
    checkBudgetWithExistingServices({
      userId: 7,
      month: '2026-07',
      retrieveBudgetConfig: async () => ({
        success: false,
        error: 'mysql password leaked'
      }),
      retrieveCategoryStats: async () => ({ success: true, data: { stats: [] } }),
      calculateBudgetExecution: () => ({})
    }),
    error =>
      error.code === 'BUDGET_CHECK_UNAVAILABLE' &&
      !error.message.includes('password')
  )
})

function createDateRangeDb() {
  const calls = []
  let queryNumber = 0
  const results = [
    [{ count: 2, total: 75 }],
    [{ id: 2, amount: 50, amount_cny: 50 }],
    [
      { id: 2, amount: 50, amount_cny: 50 },
      { id: 1, amount: 25, amount_cny: 25 }
    ]
  ]
  const db = table => {
    assert.equal(table, 'records')
    const current = queryNumber++
    const builder = {
      where(...args) {
        calls.push(['where', ...args])
        return this
      },
      orderByRaw(...args) {
        calls.push(['orderByRaw', ...args])
        return this
      },
      orderBy(...args) {
        calls.push(['orderBy', ...args])
        return this
      },
      limit(value) {
        calls.push(['limit', value])
        return this
      },
      select(...args) {
        calls.push(['select', ...args])
        return Promise.resolve(structuredClone(results[current]))
      }
    }
    return builder
  }
  db.raw = value => `RAW:${value}`
  db.calls = calls
  return db
}

test('date-range adapter uses parameterized user and inclusive date predicates', async () => {
  const db = createDateRangeDb()
  const result = await queryFinanceDateRange({
    userId: 7,
    hints: {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      category: '餐饮',
      type: 'expense',
      queryKind: 'recent'
    },
    dbClient: db,
    limit: 5
  })
  const serialized = JSON.stringify(db.calls)
  assert.equal(serialized.includes('["where","user_id",7]'), true)
  assert.equal(serialized.includes('["where","date",">=","2026-07-01"]'), true)
  assert.equal(serialized.includes('["where","date","<=","2026-07-31"]'), true)
  assert.equal(serialized.includes('["where","category","餐饮"]'), true)
  assert.equal(serialized.includes('["where","type","expense"]'), true)
  assert.equal(serialized.includes('COALESCE(amount_cny, amount)'), true)
  assert.equal(result.count, 2)
  assert.equal(result.total, 75)
  assert.equal(result.records.length, 2)
})

test('query tool routes paired date ranges away from the legacy month query', async () => {
  let legacyCalls = 0
  const rangeCalls = []
  const tools = toolsByName({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    queryFinanceSummary: async () => { legacyCalls += 1 },
    queryFinanceDateRange: async input => {
      rangeCalls.push(input)
      return { count: 0, total: 0, records: [] }
    },
    datasetStore: {
      async put(input) {
        return { datasetRef: 'ds-1', count: 0, scope: input.scope }
      }
    },
    operationStore: {}
  })
  await tools.query_transactions.invoke({
    startDate: '2026-07-01',
    endDate: '2026-07-31'
  })
  assert.equal(legacyCalls, 0)
  assert.deepEqual(rangeCalls[0], {
    userId: 7,
    hints: {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      queryKind: 'summary'
    }
  })
})

test('query tool requires a complete ordered date range', async () => {
  const tools = toolsByName({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    datasetStore: {},
    operationStore: {}
  })
  for (const input of [
    { startDate: '2026-07-01' },
    { endDate: '2026-07-31' },
    { startDate: '2026-07-31', endDate: '2026-07-01' }
  ]) {
    await assert.rejects(tools.query_transactions.invoke(input))
  }
})

test('query tool contains legacy and date-range database details', async () => {
  for (const useRange of [false, true]) {
    const tools = toolsByName({
      runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
      queryFinanceSummary: async () => {
        throw new Error('SELECT * FROM records password=legacy-secret')
      },
      queryFinanceDateRange: async () => {
        throw new Error('SELECT date FROM records password=range-secret')
      },
      datasetStore: {},
      operationStore: {}
    })
    const input = useRange
      ? { startDate: '2026-07-01', endDate: '2026-07-31' }
      : { month: '2026-07' }
    await assert.rejects(
      tools.query_transactions.invoke(input),
      error =>
        error.code === 'QUERY_TRANSACTIONS_FAILED' &&
        error.statusCode === 503 &&
        error.message === 'transaction query failed' &&
        !error.message.includes('secret')
    )
  }
})

test('query tool contains unknown dataset persistence failures', async () => {
  const tools = toolsByName({
    runtime: { userId: 7, requestId: 'request-1', operationId: 'operation-1' },
    queryFinanceSummary: async () => ({ records: [] }),
    datasetStore: {
      async put() {
        throw new Error('redis://:secret@internal')
      }
    },
    operationStore: {}
  })
  await assert.rejects(
    tools.query_transactions.invoke({ month: '2026-07' }),
    error =>
      error.code === 'QUERY_TRANSACTIONS_FAILED' &&
      error.message === 'transaction query failed' &&
      !error.message.includes('secret')
  )
})
