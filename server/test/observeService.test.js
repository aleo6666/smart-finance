import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getObserveStats,
  recordAgentEvent,
  recordLlmCall
} from '../src/services/observeService.js'

function daysAgo(days) {
  const date = new Date('2026-07-18T12:00:00.000Z')
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function createTableQuery(rows) {
  const state = {
    where: [],
    whereRaw: [],
    selected: [],
    groupedBy: null,
    inserted: null,
    firstOnly: false
  }

  function applyFilters() {
    return rows.filter(row => {
      for (const condition of state.where) {
        for (const [key, value] of Object.entries(condition)) {
          if (row[key] !== value) return false
        }
      }
      for (const raw of state.whereRaw) {
        if (raw.sql.includes('created_at >=') && new Date(row.created_at) < new Date(raw.bindings[0])) return false
      }
      return true
    })
  }

  const query = {
    state,
    insert(value) {
      rows.push(value)
      state.inserted = value
      return Promise.resolve([rows.length])
    },
    where(condition) {
      state.where.push(condition)
      return query
    },
    whereRaw(sql, bindings) {
      state.whereRaw.push({ sql, bindings })
      return query
    },
    select(...columns) {
      state.selected = columns
      return query
    },
    count() { return query },
    sum() { return query },
    avg() { return query },
    groupBy(column) {
      state.groupedBy = column
      return query
    },
    first() {
      state.firstOnly = true
      return Promise.resolve(applyFilters()[0])
    },
    then(resolve, reject) {
      try {
        const data = applyFilters()
        return Promise.resolve(data).then(resolve, reject)
      } catch (error) {
        return Promise.reject(error).then(resolve, reject)
      }
    }
  }
  return query
}

function createFakeDb(seed) {
  const tables = {
    llm_calls: [...(seed.llm_calls || [])],
    ocr_evaluations: [...(seed.ocr_evaluations || [])]
  }

  function db(table) {
    return createTableQuery(tables[table])
  }

  db.tables = tables
  db.raw = (sql, bindings) => ({ sql, bindings })
  return db
}

test('recordLlmCall writes complete call data', async () => {
  const db = createFakeDb({ llm_calls: [] })

  const result = await recordLlmCall({
    userId: 7,
    conversationId: 'conv-1',
    provider: 'zhipu',
    model: 'glm-4v-flash',
    callType: 'ocr',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 321,
    costUsd: 0.123456,
    success: false,
    errorMessage: 'timeout',
    dbClient: db
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.success, false)
  assert.equal(db.tables.llm_calls[0].user_id, 7)
  assert.equal(db.tables.llm_calls[0].conversation_id, 'conv-1')
  assert.equal(db.tables.llm_calls[0].provider, 'zhipu')
  assert.equal(db.tables.llm_calls[0].model, 'glm-4v-flash')
  assert.equal(db.tables.llm_calls[0].call_type, 'ocr')
  assert.equal(db.tables.llm_calls[0].input_tokens, 100)
  assert.equal(db.tables.llm_calls[0].output_tokens, 50)
  assert.equal(db.tables.llm_calls[0].latency_ms, 321)
  assert.equal(db.tables.llm_calls[0].cost_usd, 0.123456)
  assert.equal(db.tables.llm_calls[0].success, 0)
  assert.equal(db.tables.llm_calls[0].error_message, 'timeout')
})

test('recordAgentEvent writes local agent defaults through recordLlmCall', async () => {
  const db = createFakeDb({ llm_calls: [] })

  const result = await recordAgentEvent({
    userId: 8,
    callType: 'recorder',
    latencyMs: 44,
    dbClient: db
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(db.tables.llm_calls[0].provider, 'local')
  assert.equal(db.tables.llm_calls[0].model, 'agent')
  assert.equal(db.tables.llm_calls[0].call_type, 'recorder')
  assert.equal(db.tables.llm_calls[0].latency_ms, 44)
  assert.equal(db.tables.llm_calls[0].cost_usd, 0)
})

test('getObserveStats aggregates calls providers and OCR accuracy for user and period', async () => {
  const db = createFakeDb({
    llm_calls: [
      { user_id: 7, provider: 'local', model: 'agent', call_type: 'agent', input_tokens: 0, output_tokens: 0, latency_ms: 20, cost_usd: 0, success: 1, created_at: daysAgo(1) },
      { user_id: 7, provider: 'zhipu', model: 'glm-4v-flash', call_type: 'ocr', input_tokens: 100, output_tokens: 50, latency_ms: 300, cost_usd: 0.12, success: 1, created_at: daysAgo(2) },
      { user_id: 7, provider: 'zhipu', model: 'glm-4v-flash', call_type: 'ocr', input_tokens: 100, output_tokens: 0, latency_ms: 900, cost_usd: 0.2, success: 0, created_at: daysAgo(3) },
      { user_id: 9, provider: 'zhipu', model: 'other', call_type: 'ocr', input_tokens: 100, output_tokens: 0, latency_ms: 100, cost_usd: 9, success: 1, created_at: daysAgo(1) },
      { user_id: 7, provider: 'old', model: 'old', call_type: 'llm', input_tokens: 1, output_tokens: 1, latency_ms: 1, cost_usd: 1, success: 1, created_at: daysAgo(40) }
    ],
    ocr_evaluations: [
      { user_id: 7, user_confirmed: 1, user_corrected: 0, ocr_correct: 1, created_at: daysAgo(1) },
      { user_id: 7, user_confirmed: 1, user_corrected: 1, ocr_correct: 0, created_at: daysAgo(2) },
      { user_id: 7, user_confirmed: 0, user_corrected: 0, ocr_correct: null, created_at: daysAgo(3) },
      { user_id: 9, user_confirmed: 1, user_corrected: 0, ocr_correct: 1, created_at: daysAgo(1) }
    ]
  })

  const stats = await getObserveStats({
    userId: 7,
    period: '30d',
    now: new Date('2026-07-18T12:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(stats.period, { key: '30d', days: 30 })
  assert.equal(stats.summary.calls, 3)
  assert.equal(stats.summary.failures, 1)
  assert.equal(stats.summary.successRate, 66.67)
  assert.equal(stats.summary.totalCostUsd, 0.32)
  assert.equal(stats.summary.avgLatencyMs, 407)
  assert.deepEqual(stats.byType.map(row => row.callType), ['agent', 'ocr'])
  assert.equal(stats.byType.find(row => row.callType === 'ocr').failures, 1)
  assert.deepEqual(stats.byProvider.map(row => row.provider), ['local', 'zhipu'])
  assert.deepEqual(stats.ocr, { total: 3, confirmed: 2, corrected: 1, accuracy: 50 })
})

test('getObserveStats falls back invalid period to 30d', async () => {
  const db = createFakeDb({ llm_calls: [], ocr_evaluations: [] })

  const stats = await getObserveStats({
    userId: 7,
    period: 'bad',
    now: new Date('2026-07-18T12:00:00.000Z'),
    dbClient: db
  })

  assert.deepEqual(stats.period, { key: '30d', days: 30 })
  assert.equal(stats.summary.calls, 0)
  assert.equal(stats.summary.successRate, 100)
  assert.equal(stats.ocr.accuracy, null)
})
