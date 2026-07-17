import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBadCaseDataset,
  toJsonl
} from '../src/services/badCaseCollector.js'

function createQuery(table, tables) {
  const state = { where: [], whereRaw: [] }

  function apply() {
    return tables[table].filter(row => {
      for (const condition of state.where) {
        for (const [key, value] of Object.entries(condition)) {
          if (row[key] !== value) return false
        }
      }
      for (const raw of state.whereRaw) {
        if (raw.sql.includes('DATE_FORMAT')) {
          const dateValue = String(row.confirmed_at || row.created_at || '')
          if (dateValue.slice(0, 7) !== raw.bindings[0]) return false
        }
      }
      return true
    })
  }

  const query = {
    where(condition) {
      state.where.push(condition)
      return query
    },
    whereRaw(sql, bindings) {
      state.whereRaw.push({ sql, bindings })
      return query
    },
    orderBy() { return query },
    then(resolve, reject) {
      return Promise.resolve(apply()).then(resolve, reject)
    }
  }
  return query
}

function createFakeDb(seed = {}) {
  const tables = {
    ocr_evaluations: [...(seed.ocr_evaluations || [])],
    feedback: [...(seed.feedback || [])]
  }
  function db(table) {
    return createQuery(table, tables)
  }
  db.tables = tables
  return db
}

test('buildBadCaseDataset creates OCR correction item', async () => {
  const db = createFakeDb({
    ocr_evaluations: [{
      id: 1,
      record_id: 42,
      user_id: 7,
      ocr_result: JSON.stringify({ records: [{ amount: 80, category: '购物', description: '晚餐' }] }),
      user_corrected: 1,
      corrected_category: '餐饮',
      corrected_amount: 88,
      created_at: '2026-07-18 10:00:00'
    }]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'ocr', dbClient: db })

  assert.equal(data.length, 1)
  assert.equal(data[0].source, 'ocr')
  assert.equal(data[0].metadata.recordId, 42)
  assert.match(data[0].messages[2].content, /餐饮/)
  assert.match(data[0].messages[2].content, /88/)
})

test('buildBadCaseDataset creates insight feedback item', async () => {
  const db = createFakeDb({
    feedback: [{
      id: 5,
      user_id: 7,
      type: 'ai_insight',
      priority: 'P1',
      content: JSON.stringify({
        insightId: 'food-risk',
        reportId: 9,
        isAccurate: false,
        correction: '这是一次性聚餐，不是长期趋势',
        context: { summary: '餐饮异常上升', period: '2026-07' }
      }),
      created_at: '2026-07-18 10:00:00'
    }]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'insight', dbClient: db })

  assert.equal(data.length, 1)
  assert.equal(data[0].source, 'insight')
  assert.equal(data[0].metadata.feedbackId, 5)
  assert.match(data[0].messages[0].content, /餐饮异常上升/)
  assert.match(data[0].messages[1].content, /避免该判断/)
})

test('buildBadCaseDataset source filter returns only requested source and scopes user', async () => {
  const db = createFakeDb({
    ocr_evaluations: [
      { id: 1, record_id: 1, user_id: 7, ocr_result: '{}', user_corrected: 1, corrected_category: '餐饮', corrected_amount: 10, created_at: '2026-07-18 10:00:00' },
      { id: 2, record_id: 2, user_id: 8, ocr_result: '{}', user_corrected: 1, corrected_category: '购物', corrected_amount: 20, created_at: '2026-07-18 10:00:00' }
    ],
    feedback: [
      { id: 3, user_id: 7, type: 'ai_insight', priority: 'P2', content: '{}', created_at: '2026-07-18 10:00:00' }
    ]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'ocr', dbClient: db })

  assert.deepEqual(data.map(item => item.source), ['ocr'])
  assert.equal(data[0].metadata.userId, 7)
})

test('buildBadCaseDataset downgrades invalid JSON and toJsonl emits one JSON object per line', async () => {
  const db = createFakeDb({
    feedback: [{
      id: 9,
      user_id: 7,
      type: 'ai_insight',
      priority: 'P1',
      content: '普通文本反馈',
      created_at: '2026-07-18 10:00:00'
    }]
  })

  const data = await buildBadCaseDataset({ userId: 7, month: '2026-07', source: 'all', dbClient: db })
  const jsonl = toJsonl(data)

  assert.equal(data.length, 1)
  assert.match(data[0].messages[0].content, /普通文本反馈/)
  assert.equal(jsonl.split('\n').length, 1)
  assert.equal(JSON.parse(jsonl).source, 'insight')
})
