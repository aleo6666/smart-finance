import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createRecentSummaryRepository,
  emptySummary,
  sanitizeSummary
} from '../../src/agent/memory/recentSummary.js'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createFakeDb({
  row = null,
  writeError = null,
  dbNow = new Date('2026-07-26T00:00:00.000Z')
} = {}) {
  const state = { row: clone(row), queries: [], writes: [] }

  const db = table => {
    assert.equal(table, 'conversation_summaries')
    const query = {
      criteria: {},
      expiry: null,
      insertValue: null,
      where(value) {
        if (typeof value === 'function') {
          const expiryQuery = {
            where(field, operator, threshold) {
              query.expiry = { field, operator, threshold }
              return this
            }
          }
          value(expiryQuery)
          return this
        }
        query.criteria = { ...query.criteria, ...value }
        return this
      },
      async first() {
        state.queries.push(clone({
          criteria: query.criteria,
          expiry: query.expiry
        }))
        if (!state.row) return undefined
        if (!Object.entries(query.criteria).every(([key, value]) => state.row[key] === value)) {
          return undefined
        }
        if (
          query.expiry &&
          new Date(state.row[query.expiry.field]).getTime() <=
            new Date(query.expiry.threshold).getTime()
        ) {
          return undefined
        }
        return clone(state.row)
      },
      insert(value) {
        query.insertValue = clone(value)
        return this
      },
      onConflict(columns) {
        assert.deepEqual(columns, ['user_id', 'session_id'])
        return {
          async merge(columnsToMerge) {
            if (writeError) throw writeError
            state.writes.push({
              row: clone(query.insertValue),
              conflict: clone(columns),
              merge: clone(columnsToMerge)
            })
            state.row = {
              ...(state.row || {}),
              ...clone(query.insertValue)
            }
            return [1]
          }
        }
      }
    }
    return query
  }
  db.fn = { now: () => clone(dbNow) }
  db.state = state
  return db
}

test('emptySummary and sanitizer expose only bounded structured summary fields', () => {
  assert.deepEqual(emptySummary(), {
    currentTopics: [],
    recentReferences: [],
    unfinishedTasks: [],
    analysisConclusions: [],
    plannedActions: [],
    temporaryContext: {}
  })

  const cyclic = {}
  cyclic.self = cyclic
  const sanitized = sanitizeSummary({
    currentTopics: [
      '餐饮',
      '餐饮',
      ...Array.from({ length: 20 }, (_, index) => `topic-${index}`),
      'x'.repeat(1000),
      cyclic,
      null
    ],
    recentReferences: ['上月分析'],
    unfinishedTasks: Array(8).fill('结论'.repeat(200)).map((item, index) => `${index}${item}`),
    analysisConclusions: Array(8).fill('分析'.repeat(200)).map((item, index) => `${index}${item}`),
    plannedActions: Array(8).fill('计划'.repeat(200)).map((item, index) => `${index}${item}`),
    temporaryContext: {
      currentMonth: '2026-07',
      currentLedgerId: 12,
      currentCategory: '餐饮',
      userId: 999,
      rawContent: '原始敏感内容'
    },
    messages: [{ role: 'user', content: '完整聊天原文' }],
    rawTranscript: '完整录音转写',
    rawContent: '完整长文',
    transactions: [{ amount: 999 }]
  })

  assert.deepEqual(Object.keys(sanitized), Object.keys(emptySummary()))
  assert.equal(sanitized.currentTopics[0], '餐饮')
  assert.equal(new Set(sanitized.currentTopics).size, sanitized.currentTopics.length)
  assert.ok(sanitized.currentTopics.length <= 8)
  assert.ok(sanitized.currentTopics.every(item =>
    typeof item === 'string' && item.length <= 256
  ))
  assert.deepEqual(sanitized.temporaryContext, {
    currentMonth: '2026-07',
    currentLedgerId: 12,
    currentCategory: '餐饮'
  })
  const serialized = JSON.stringify(sanitized)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 8192)
  assert.doesNotMatch(serialized, /完整聊天原文|完整录音转写|原始敏感内容|amount/)
  assert.doesNotThrow(() => structuredClone(sanitized))
})

test('summary repository reads exact unexpired scope with SQL expiry pushed down', async () => {
  const db = createFakeDb({
    row: {
      user_id: 7,
      session_id: 's-1',
      summary_json: JSON.stringify({
        currentTopics: ['餐饮'],
        messages: ['must not escape']
      }),
      covered_until_turn: 9,
      message_count: 18,
      expires_at: new Date('2026-08-25T00:00:00.000Z')
    }
  })
  const repository = createRecentSummaryRepository(db, {
    now: () => new Date('2026-07-26T00:00:00.000Z')
  })

  const result = await repository.read(7, 's-1')

  assert.deepEqual(result, {
    ...emptySummary(),
    currentTopics: ['餐饮']
  })
  assert.deepEqual(db.state.queries, [{
    criteria: { user_id: 7, session_id: 's-1' },
    expiry: {
      field: 'expires_at',
      operator: '>',
      threshold: new Date('2026-07-26T00:00:00.000Z')
    }
  }])
})

test('summary repository safely returns empty summary for bad JSON and expired rows', async () => {
  const badJsonDb = createFakeDb({
    row: {
      user_id: 7,
      session_id: 's-1',
      summary_json: '{not-json',
      expires_at: new Date('2026-08-01T00:00:00.000Z')
    }
  })
  const expiredDb = createFakeDb({
    row: {
      user_id: 7,
      session_id: 's-1',
      summary_json: JSON.stringify({ currentTopics: ['stale'] }),
      expires_at: new Date('2026-07-25T00:00:00.000Z')
    }
  })
  const options = { now: () => new Date('2026-07-26T00:00:00.000Z') }

  assert.deepEqual(
    await createRecentSummaryRepository(badJsonDb, options).read(7, 's-1'),
    emptySummary()
  )
  assert.deepEqual(
    await createRecentSummaryRepository(expiredDb, options).read(7, 's-1'),
    emptySummary()
  )
})

test('summary upsert uses exact scope, retention and sanitized bounded counters', async () => {
  const db = createFakeDb()
  const repository = createRecentSummaryRepository(db, {
    retentionDays: 30,
    now: () => new Date('2026-07-26T12:00:00.000Z')
  })

  const result = await repository.upsert({
    userId: 7,
    sessionId: 's-1',
    summary: {
      plannedActions: ['每周复盘'],
      messages: [{ content: 'never persist me' }]
    },
    coveredUntilTurn: 9.9,
    messageCount: Number.MAX_SAFE_INTEGER
  })

  assert.deepEqual(result, {
    ...emptySummary(),
    plannedActions: ['每周复盘']
  })
  assert.equal(db.state.writes.length, 1)
  const [{ row, merge }] = db.state.writes
  assert.equal(row.user_id, 7)
  assert.equal(row.session_id, 's-1')
  assert.equal(row.covered_until_turn, 9)
  assert.equal(row.message_count, 1_000_000)
  assert.equal(
    new Date(row.expires_at).toISOString(),
    '2026-08-25T12:00:00.000Z'
  )
  assert.deepEqual(merge, [
    'summary_json',
    'covered_until_turn',
    'message_count',
    'expires_at',
    'updated_at'
  ])
  assert.doesNotMatch(row.summary_json, /messages|never persist me/)
})

test('summary repository validates trusted scope and propagates database writes', async () => {
  const writeError = new Error('mysql unavailable: secret-host')
  const repository = createRecentSummaryRepository(
    createFakeDb({ writeError }),
    { retentionDays: 30 }
  )

  await assert.rejects(
    repository.read(0, 's-1'),
    error => error.code === 'ERR_INVALID_RUNTIME_CONTEXT'
  )
  await assert.rejects(
    repository.upsert({
      userId: 7,
      sessionId: '../other',
      summary: emptySummary(),
      coveredUntilTurn: 0,
      messageCount: 0
    }),
    error => error.code === 'ERR_INVALID_RUNTIME_CONTEXT'
  )
  await assert.rejects(
    repository.upsert({
      userId: 7,
      sessionId: 's-1',
      summary: emptySummary(),
      coveredUntilTurn: 0,
      messageCount: 0
    }),
    writeError
  )
})
