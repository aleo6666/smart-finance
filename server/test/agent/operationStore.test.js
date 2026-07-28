import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createOperationStore,
  hashOperation
} from '../../src/agent/stores/operationStore.js'

function createFakeDb({ insertError = null } = {}) {
  const rows = []
  const db = table => {
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
        if (insertError) throw insertError
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
  db.rows = rows
  return db
}

function createFailingDb({ insertError, selectError, updateError }) {
  const db = () => ({
    where() { return this },
    async insert() { if (insertError) throw insertError },
    async first() { if (selectError) throw selectError },
    async update() { if (updateError) throw updateError; return 1 }
  })
  return db
}

test('operation hash is stable across object key order', () => {
  assert.equal(
    hashOperation({ type: 'record', input: { amount: 25, category: '交通' } }),
    hashOperation({ input: { category: '交通', amount: 25 }, type: 'record' })
  )
})

test('operation store can bind all operations to an existing Knex transaction', async () => {
  const rootDb = createFakeDb()
  const transactionDb = createFakeDb()
  const store = createOperationStore(rootDb).withDb(transactionDb)

  const claim = await store.claim({
    userId: 7,
    operationId: 'operation-transaction',
    operationType: 'ocr_confirm',
    input: { uploadId: 'session-1' }
  })
  await store.succeed({
    userId: 7,
    operationId: 'operation-transaction',
    inputHash: claim.inputHash,
    result: { count: 1 }
  })

  assert.equal(rootDb.rows.length, 0)
  assert.equal(transactionDb.rows.length, 1)
  assert.equal(transactionDb.rows[0].status, 'succeeded')
})

test('operation claim owns once and replays only the same successful input', async () => {
  const store = createOperationStore(createFakeDb())
  const input = { amount: 25, category: '交通' }
  const first = await store.claim({
    userId: 7,
    operationId: 'operation-1',
    operationType: 'record_transaction',
    input
  })
  assert.equal(first.status, 'owner')
  await store.succeed({
    userId: 7,
    operationId: 'operation-1',
    inputHash: first.inputHash,
    result: { recordIds: [9] }
  })

  const replay = await store.claim({
    userId: 7,
    operationId: 'operation-1',
    operationType: 'record_transaction',
    input
  })
  assert.deepEqual(replay, {
    status: 'succeeded',
    result: { recordIds: [9] }
  })

  await assert.rejects(
    store.claim({
      userId: 7,
      operationId: 'operation-1',
      operationType: 'record_transaction',
      input: { amount: 99, category: '交通' }
    }),
    error => error.code === 'OPERATION_ID_CONFLICT' && error.statusCode === 409
  )
})

test('duplicate started operations report in progress and remain user isolated', async () => {
  const db = createFakeDb()
  const store = createOperationStore(db)
  const input = { amount: 25 }
  await store.claim({
    userId: 7,
    operationId: 'operation-1',
    operationType: 'record_transaction',
    input
  })
  assert.deepEqual(await store.claim({
    userId: 7,
    operationId: 'operation-1',
    operationType: 'record_transaction',
    input
  }), { status: 'in_progress' })
  assert.equal((await store.claim({
    userId: 8,
    operationId: 'operation-1',
    operationType: 'record_transaction',
    input
  })).status, 'owner')
})

test('operation store recognizes only real MySQL duplicate errors', async () => {
  for (const duplicate of [
    Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }),
    Object.assign(new Error('duplicate'), { errno: 1062 })
  ]) {
    await assert.rejects(
      createOperationStore(createFakeDb({ insertError: duplicate })).claim({
        userId: 7,
        operationId: 'operation-1',
        operationType: 'record_transaction',
        input: {}
      }),
      error => error.code === 'OPERATION_ID_CONFLICT'
    )
  }

  const ordinary = Object.assign(new Error('connection lost'), {
    code: 'PROTOCOL_CONNECTION_LOST'
  })
  await assert.rejects(
    createOperationStore(createFakeDb({ insertError: ordinary })).claim({
      userId: 7,
      operationId: 'operation-1',
      operationType: 'record_transaction',
      input: {}
    }),
    error =>
      error.code === 'OPERATION_STORE_UNAVAILABLE' &&
      error.statusCode === 503 &&
      !error.message.includes(ordinary.message)
  )
})

test('operation rows contain only a hash, and terminal updates require exact ownership', async () => {
  const db = createFakeDb()
  const store = createOperationStore(db)
  const secret = 'private raw description'
  const claim = await store.claim({
    userId: 7,
    operationId: 'operation-1',
    operationType: 'record_transaction',
    input: { description: secret }
  })
  assert.equal(JSON.stringify(db.rows).includes(secret), false)
  await assert.rejects(
    store.succeed({
      userId: 7,
      operationId: 'operation-1',
      inputHash: '0'.repeat(64),
      result: {}
    }),
    error => error.code === 'OPERATION_STATE_CONFLICT'
  )
  await store.fail({
    userId: 7,
    operationId: 'operation-1',
    inputHash: claim.inputHash,
    errorCode: 'RECORD_TRANSACTION_FAILED'
  })
  assert.equal(db.rows[0].status, 'failed')
  assert.equal(db.rows[0].result_json, null)
})

test('operation store maps database failures to a typed safe unavailable error', async () => {
  const databaseMessage = 'mysql://finance:secret@internal'
  const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
  const cases = [
    () => createOperationStore(createFailingDb({
      insertError: new Error(databaseMessage)
    })).claim({
      userId: 7,
      operationId: 'operation-1',
      operationType: 'record_transaction',
      input: {}
    }),
    () => createOperationStore(createFailingDb({
      insertError: duplicate,
      selectError: new Error(databaseMessage)
    })).claim({
      userId: 7,
      operationId: 'operation-1',
      operationType: 'record_transaction',
      input: {}
    }),
    () => createOperationStore(createFailingDb({
      updateError: new Error(databaseMessage)
    })).succeed({
      userId: 7,
      operationId: 'operation-1',
      inputHash: '0'.repeat(64),
      result: {}
    }),
    () => createOperationStore(createFailingDb({
      updateError: new Error(databaseMessage)
    })).fail({
      userId: 7,
      operationId: 'operation-1',
      inputHash: '0'.repeat(64)
    })
  ]
  for (const invoke of cases) {
    await assert.rejects(
      invoke(),
      error =>
        error.code === 'OPERATION_STORE_UNAVAILABLE' &&
        error.statusCode === 503 &&
        !error.message.includes('secret')
    )
  }
})

test('failed and unknown stored states never expose persisted database values', async () => {
  for (const [status, errorCode] of [
    ['failed', 'DATABASE_SECRET'],
    ['unexpected', 'DATABASE_SECRET']
  ]) {
    const db = createFakeDb()
    const store = createOperationStore(db)
    const claim = await store.claim({
      userId: 7,
      operationId: `operation-${status}`,
      operationType: 'record_transaction',
      input: {}
    })
    db.rows[0].status = status
    db.rows[0].error_code = errorCode
    if (status === 'failed') {
      assert.deepEqual(await store.claim({
        userId: 7,
        operationId: `operation-${status}`,
        operationType: 'record_transaction',
        input: {}
      }), {
        status: 'failed',
        errorCode: 'OPERATION_FAILED'
      })
    } else {
      await assert.rejects(
        store.claim({
          userId: 7,
          operationId: `operation-${status}`,
          operationType: 'record_transaction',
          input: {}
        }),
        error =>
          error.code === 'OPERATION_STORE_UNAVAILABLE' &&
          !error.message.includes(errorCode)
      )
    }
    assert.equal(claim.status, 'owner')
  }
})

test('succeeded replay rejects corrupted result JSON but accepts JSON null', async () => {
  for (const [stored, expected] of [
    ['not-json mysql-secret', 'reject'],
    ['null', null]
  ]) {
    const db = createFakeDb()
    const store = createOperationStore(db)
    await store.claim({
      userId: 7,
      operationId: 'operation-replay',
      operationType: 'record_transaction',
      input: {}
    })
    db.rows[0].status = 'succeeded'
    db.rows[0].result_json = stored
    const replay = store.claim({
      userId: 7,
      operationId: 'operation-replay',
      operationType: 'record_transaction',
      input: {}
    })
    if (expected === 'reject') {
      await assert.rejects(
        replay,
        error =>
          error.code === 'OPERATION_STORE_UNAVAILABLE' &&
          error.statusCode === 503 &&
          !error.message.includes('mysql-secret')
      )
    } else {
      assert.deepEqual(await replay, { status: 'succeeded', result: null })
    }
  }
})
