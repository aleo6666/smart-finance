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

test('operation hash is stable across object key order', () => {
  assert.equal(
    hashOperation({ type: 'record', input: { amount: 25, category: '交通' } }),
    hashOperation({ input: { category: '交通', amount: 25 }, type: 'record' })
  )
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

test('operation store only maps real MySQL duplicate errors', async () => {
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
    error => error === ordinary
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
