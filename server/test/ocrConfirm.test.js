import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createOcrConfirmOperationId,
  normalizeOcrRecord,
  isUserCorrected,
  saveConfirmedOcrRecords
} from '../src/services/ocrConfirm.js'

function validConfirmedRecord(overrides = {}) {
  return {
    type: 'expense',
    amount: 25,
    category: '餐饮',
    description: '午餐',
    date: '2026-07-27',
    merchant: '餐厅',
    ...overrides
  }
}

function createOperationStore() {
  const operations = new Map()
  const store = {
    withDb() {
      return store
    },
    async claim({ userId, operationId, operationType, input }) {
      const key = `${userId}:${operationId}`
      const serialized = JSON.stringify({ operationType, input })
      const existing = operations.get(key)
      if (existing) {
        if (existing.serialized !== serialized) {
          const error = new Error('conflict')
          error.code = 'OPERATION_ID_CONFLICT'
          throw error
        }
        if (existing.status === 'succeeded') {
          return { status: 'succeeded', result: existing.result }
        }
        return { status: existing.status === 'started' ? 'in_progress' : 'failed' }
      }
      const inputHash = `hash-${operations.size + 1}`
      operations.set(key, { serialized, status: 'started', inputHash })
      return { status: 'owner', inputHash }
    },
    async succeed({ userId, operationId, inputHash, result }) {
      const operation = operations.get(`${userId}:${operationId}`)
      assert.equal(operation.inputHash, inputHash)
      operation.status = 'succeeded'
      operation.result = result
    },
    async fail({ userId, operationId, inputHash }) {
      const operation = operations.get(`${userId}:${operationId}`)
      assert.equal(operation.inputHash, inputHash)
      operation.status = 'failed'
    }
  }
  return store
}

function createAtomicHarness({ failSucceed = false } = {}) {
  let committed = {
    records: [],
    evaluations: [],
    operations: new Map()
  }
  let rejectSucceed = failSucceed

  const repository = {
    async transaction(work) {
      const draft = structuredClone(committed)
      const trx = { draft }
      const result = await work(trx)
      committed = draft
      return result
    },
    async insertRecord(record, trx) {
      const id = trx.draft.records.length + 1
      trx.draft.records.push({ ...record, id })
      return id
    },
    async fetchRecord(id, _userId, trx) {
      return structuredClone(trx.draft.records.find(record => record.id === id))
    },
    async insertEvaluation(evaluation, trx) {
      trx.draft.evaluations.push(structuredClone(evaluation))
    }
  }

  const operationStore = {
    withDb(trx) {
      return {
        async claim({ userId, operationId, operationType, input }) {
          const key = `${userId}:${operationId}`
          const serialized = JSON.stringify({ operationType, input })
          const existing = trx.draft.operations.get(key)
          if (existing) {
            if (existing.serialized !== serialized) {
              const error = new Error('conflict')
              error.code = 'OPERATION_ID_CONFLICT'
              throw error
            }
            if (existing.status === 'succeeded') {
              return { status: 'succeeded', result: existing.result }
            }
            return { status: 'in_progress' }
          }
          const inputHash = 'atomic-input-hash'
          trx.draft.operations.set(key, {
            serialized,
            status: 'started',
            inputHash
          })
          return { status: 'owner', inputHash }
        },
        async succeed({ userId, operationId, inputHash, result }) {
          if (rejectSucceed) throw new Error('terminal update failed')
          const operation = trx.draft.operations.get(`${userId}:${operationId}`)
          assert.equal(operation.inputHash, inputHash)
          assert.equal(operation.status, 'started')
          operation.status = 'succeeded'
          operation.result = structuredClone(result)
        }
      }
    }
  }

  return {
    repository,
    operationStore,
    get committed() {
      return committed
    },
    allowSucceed() {
      rejectSucceed = false
    }
  }
}

test('normalizeOcrRecord accepts a valid confirmed OCR record', () => {
  const record = normalizeOcrRecord({
    type: 'expense',
    amount: '25.50',
    category: '餐饮',
    description: '午餐',
    date: '2026-07-17',
    merchant: '某某餐厅'
  })

  assert.equal(record.type, 'expense')
  assert.equal(record.amount, 25.5)
  assert.equal(record.category, '餐饮')
  assert.equal(record.description, '午餐')
  assert.equal(record.date, '2026-07-17')
  assert.equal(record.merchant, '某某餐厅')
})

test('normalizeOcrRecord rejects invalid amount and date', () => {
  assert.throws(() => normalizeOcrRecord({ amount: 0, category: '餐饮', date: '2026-07-17' }), /金额必须大于 0/)
  assert.throws(() => normalizeOcrRecord({ amount: 1, category: '餐饮', date: '2026/07/17' }), /日期格式必须是 YYYY-MM-DD/)
})

test('isUserCorrected detects changed key fields', () => {
  const original = { amount: 25, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }
  assert.equal(isUserCorrected(original, { ...original }), false)
  assert.equal(isUserCorrected(original, { ...original, amount: 26 }), true)
  assert.equal(isUserCorrected(original, { ...original, category: '购物' }), true)
})

test('saveConfirmedOcrRecords inserts records and OCR evaluations', async () => {
  const insertedRecords = []
  const insertedEvaluations = []
  const embedded = []
  const monitored = []

  const repository = {
    async transaction(work) {
      return work('trx')
    },
    async insertRecord(record) {
      insertedRecords.push(record)
      return insertedRecords.length
    },
    async fetchRecord(id) {
      return { ...insertedRecords[id - 1], id }
    },
    async insertEvaluation(evaluation) {
      insertedEvaluations.push(evaluation)
    }
  }

  const result = await saveConfirmedOcrRecords({
    userId: 7,
    deviceId: 'user-7',
    session: {
      userId: 7,
      records: [{ amount: 25, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }]
    },
    uploadId: 'session-basic',
    operationId: createOcrConfirmOperationId({ userId: 7, uploadId: 'session-basic' }),
    operationStore: createOperationStore(),
    confirmedRecords: [{ amount: 26, category: '餐饮', date: '2026-07-17', merchant: 'A', description: '午餐' }],
    repository,
    embedRecordFn: async record => embedded.push(record),
    checkBudgetAfterRecordFn: async input => monitored.push(input),
    billVectorWriteEnabled: true
  })

  assert.equal(result.count, 1)
  assert.equal(result.records[0].id, 1)
  assert.equal(insertedRecords[0].user_id, 7)
  assert.equal(insertedRecords[0].amount, 26)
  assert.equal(insertedEvaluations[0].record_id, 1)
  assert.equal(insertedEvaluations[0].user_corrected, 1)
  assert.equal(insertedEvaluations[0].ocr_correct, 0)
  assert.equal(insertedEvaluations[0].corrected_amount, 26)
  assert.equal(embedded[0].id, 1)
  assert.equal(monitored[0].record.id, 1)
})

test('concurrent and repeated OCR confirmations insert each record only once', async () => {
  let inserts = 0
  const operationStore = createOperationStore()
  const repository = {
    async transaction(work) {
      await new Promise(resolve => setTimeout(resolve, 10))
      return work('trx')
    },
    async insertRecord() {
      inserts += 1
      return inserts
    },
    async fetchRecord(id) {
      return { id, amount: 25 }
    },
    async insertEvaluation() {}
  }
  const input = {
    userId: 7,
    deviceId: 'user-7',
    session: {
      userId: 7,
      records: [validConfirmedRecord()]
    },
    uploadId: 'session-1',
    operationId: createOcrConfirmOperationId({ userId: 7, uploadId: 'session-1' }),
    operationStore,
    confirmedRecords: [validConfirmedRecord()],
    repository,
    embedRecordFn: async () => {},
    checkBudgetAfterRecordFn: async () => {}
  }

  const [first, concurrent] = await Promise.all([
    saveConfirmedOcrRecords(input),
    saveConfirmedOcrRecords(input)
  ])
  const repeated = await saveConfirmedOcrRecords(input)

  assert.equal(inserts, 1)
  assert.equal(first.count, 1)
  assert.deepEqual(concurrent, first)
  assert.deepEqual(repeated, first)
})

test('OCR confirmation rejects cross-user sessions before claiming or writing', async () => {
  let claims = 0
  let inserts = 0
  await assert.rejects(
    saveConfirmedOcrRecords({
      userId: 7,
      session: { userId: 8, records: [validConfirmedRecord()] },
      uploadId: 'session-1',
      operationId: createOcrConfirmOperationId({ userId: 7, uploadId: 'session-1' }),
      operationStore: {
        async claim() {
          claims += 1
        }
      },
      confirmedRecords: [validConfirmedRecord()],
      repository: {
        async transaction(work) {
          return work('trx')
        },
        async insertRecord() {
          inserts += 1
        }
      }
    }),
    error => error.code === 'FORBIDDEN' && error.statusCode === 403
  )
  assert.equal(claims, 0)
  assert.equal(inserts, 0)
})

test('same OCR confirmation operation rejects a changed preview', async () => {
  const operationStore = createOperationStore()
  const operationId = createOcrConfirmOperationId({ userId: 7, uploadId: 'session-1' })
  const common = {
    userId: 7,
    session: { userId: 7, records: [validConfirmedRecord()] },
    uploadId: 'session-1',
    operationId,
    operationStore,
    repository: {
      async transaction(work) { return work('trx') },
      async insertRecord() { return 1 },
      async fetchRecord() { return { id: 1 } },
      async insertEvaluation() {}
    },
    embedRecordFn: async () => {},
    checkBudgetAfterRecordFn: async () => {}
  }

  await saveConfirmedOcrRecords({
    ...common,
    confirmedRecords: [validConfirmedRecord()]
  })
  await assert.rejects(
    saveConfirmedOcrRecords({
      ...common,
      confirmedRecords: [validConfirmedRecord({ amount: 99 })]
    }),
    error => error.code === 'OPERATION_ID_CONFLICT'
  )
})

test('failed OCR confirmation is safe and does not publish a failed terminal after writes', async () => {
  const operationStore = createOperationStore()
  let failCalls = 0
  operationStore.fail = async () => {
    failCalls += 1
  }
  const input = {
    userId: 7,
    session: { userId: 7, records: [validConfirmedRecord()] },
    uploadId: 'session-1',
    operationId: createOcrConfirmOperationId({ userId: 7, uploadId: 'session-1' }),
    operationStore,
    confirmedRecords: [validConfirmedRecord()],
    repository: {
      async transaction() {
        throw new Error('mysql://secret')
      }
    }
  }

  await assert.rejects(
    saveConfirmedOcrRecords(input),
    error =>
      error.code === 'OCR_CONFIRM_FAILED' &&
      error.statusCode === 503 &&
      !error.message.includes('secret')
  )
  assert.equal(failCalls, 0)
})

test('OCR confirmation fails closed when the idempotency store is unavailable', async () => {
  let inserts = 0
  await assert.rejects(
    saveConfirmedOcrRecords({
      userId: 7,
      session: { userId: 7, records: [validConfirmedRecord()] },
      uploadId: 'session-no-store',
      operationId: createOcrConfirmOperationId({
        userId: 7,
        uploadId: 'session-no-store'
      }),
      confirmedRecords: [validConfirmedRecord()],
      repository: {
        async transaction(work) { return work('trx') },
        async insertRecord() {
          inserts += 1
          return inserts
        },
        async fetchRecord() { return { id: 1 } },
        async insertEvaluation() {}
      }
    }),
    error =>
      error.code === 'OCR_CONFIRM_IDEMPOTENCY_UNAVAILABLE' &&
      error.statusCode === 503
  )
  assert.equal(inserts, 0)
})

test('OCR records and succeeded terminal state commit atomically and retry after rollback', async () => {
  const harness = createAtomicHarness({ failSucceed: true })
  const uploadId = 'session-atomic'
  const input = {
    userId: 7,
    deviceId: 'user-7',
    session: { userId: 7, records: [validConfirmedRecord()] },
    uploadId,
    operationId: createOcrConfirmOperationId({ userId: 7, uploadId }),
    operationStore: harness.operationStore,
    confirmedRecords: [validConfirmedRecord()],
    repository: harness.repository,
    embedRecordFn: async () => {},
    checkBudgetAfterRecordFn: async () => {}
  }

  await assert.rejects(
    saveConfirmedOcrRecords(input),
    error => error.code === 'OCR_CONFIRM_FAILED'
  )
  assert.equal(harness.committed.records.length, 0)
  assert.equal(harness.committed.evaluations.length, 0)
  assert.equal(harness.committed.operations.size, 0)

  harness.allowSucceed()
  const first = await saveConfirmedOcrRecords(input)
  const replay = await saveConfirmedOcrRecords(input)

  assert.equal(harness.committed.records.length, 1)
  assert.equal(harness.committed.evaluations.length, 1)
  assert.equal([...harness.committed.operations.values()][0].status, 'succeeded')
  assert.deepEqual(replay, first)
})

test('OCR confirmation stores a JSON-safe replay result for database date values', async () => {
  const operationStore = createOperationStore()
  const originalSucceed = operationStore.succeed
  operationStore.succeed = async input => {
    assert.equal(input.result.records[0].created_at, '2026-07-27T08:00:00.000Z')
    await originalSucceed(input)
  }
  const result = await saveConfirmedOcrRecords({
    userId: 7,
    session: { userId: 7, records: [validConfirmedRecord()] },
    uploadId: 'session-json',
    operationId: createOcrConfirmOperationId({ userId: 7, uploadId: 'session-json' }),
    operationStore,
    confirmedRecords: [validConfirmedRecord()],
    repository: {
      async transaction(work) { return work('trx') },
      async insertRecord() { return 1 },
      async fetchRecord() {
        return { id: 1, created_at: new Date('2026-07-27T08:00:00.000Z') }
      },
      async insertEvaluation() {}
    },
    embedRecordFn: async () => {},
    checkBudgetAfterRecordFn: async () => {}
  })

  assert.equal(result.records[0].created_at, '2026-07-27T08:00:00.000Z')
})

test('OCR confirmation post-processing logs never include dependency error text', async () => {
  const warnings = []
  await saveConfirmedOcrRecords({
    userId: 7,
    session: { userId: 7, records: [validConfirmedRecord()] },
    uploadId: 'session-logging',
    operationId: createOcrConfirmOperationId({ userId: 7, uploadId: 'session-logging' }),
    operationStore: createOperationStore(),
    confirmedRecords: [validConfirmedRecord()],
    repository: {
      async transaction(work) { return work('trx') },
      async insertRecord() { return 1 },
      async fetchRecord() { return { id: 1 } },
      async insertEvaluation() {}
    },
    embedRecordFn: async () => {
      throw new Error('qdrant token=secret')
    },
    checkBudgetAfterRecordFn: async () => {
      throw new Error('budget row contains private details')
    },
    logger: {
      warn(...args) {
        warnings.push(args)
      }
    }
  })

  const serialized = JSON.stringify(warnings)
  assert.equal(serialized.includes('secret'), false)
  assert.equal(serialized.includes('private'), false)
})
