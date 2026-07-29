import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryVersionConflictError,
  classifyMemory,
  createUserMemoryRepository
} from '../../src/agent/memory/userMemory.js'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createFakeDb({
  failAudit = false,
  userMemoryInsertError = null
} = {}) {
  const state = { user_memories: [], memory_audit_logs: [] }
  const expiryQueries = []
  let nextId = 1

  function matches(row, criteria) {
    return Object.entries(criteria).every(([key, value]) => row[key] === value)
  }

  function makeClient(target) {
    const client = table => {
      let criteria = {}
      let expiryPredicate = null
      return {
        where(value) {
          if (typeof value === 'function') {
            const expiry = {}
            value({
              whereNull(field) {
                expiry.nullField = field
                return this
              },
              orWhere(field, operator, threshold) {
                expiry.orField = field
                expiry.operator = operator
                expiry.threshold = threshold
                return this
              }
            })
            assert.equal(expiry.nullField, 'expires_at')
            assert.equal(expiry.orField, 'expires_at')
            assert.equal(expiry.operator, '>')
            expiryQueries.push(table)
            expiryPredicate = row =>
              row.expires_at == null ||
              new Date(row.expires_at).getTime() > new Date(expiry.threshold).getTime()
            return this
          }
          criteria = { ...criteria, ...value }
          return this
        },
        forUpdate() {
          return this
        },
        async first() {
          return clone(target[table].find(row =>
            matches(row, criteria) && (!expiryPredicate || expiryPredicate(row))
          ))
        },
        async select() {
          return clone(target[table].filter(row =>
            matches(row, criteria) && (!expiryPredicate || expiryPredicate(row))
          ))
        },
        async insert(value) {
          if (table === 'memory_audit_logs' && failAudit) {
            throw new Error('audit unavailable')
          }
          if (table === 'user_memories' && userMemoryInsertError) {
            throw userMemoryInsertError
          }
          const rows = Array.isArray(value) ? value : [value]
          for (const row of rows) {
            if (
              table === 'user_memories' &&
              target.user_memories.some(existing =>
                existing.user_id === row.user_id &&
                existing.namespace === row.namespace &&
                existing.memory_key === row.memory_key
              )
            ) {
              throw new Error('duplicate memory')
            }
            target[table].push({ id: nextId++, ...clone(row) })
          }
          return [nextId - 1]
        },
        async update(value) {
          let count = 0
          for (const row of target[table]) {
            if (matches(row, criteria)) {
              Object.assign(row, clone(value))
              count += 1
            }
          }
          return count
        }
      }
    }
    client.fn = { now: () => new Date('2026-07-26T00:00:00.000Z') }
    return client
  }

  const db = makeClient(state)
  db.transaction = async callback => {
    const pending = clone(state)
    const result = await callback(makeClient(pending))
    state.user_memories = pending.user_memories
    state.memory_audit_logs = pending.memory_audit_logs
    return result
  }
  db.state = state
  db.expiryQueries = expiryQueries
  return db
}

test('classifyMemory permits low-risk profile and preference keys', () => {
  assert.equal(classifyMemory('user_profile', 'name'), 'normal')
  assert.equal(classifyMemory('preferences', 'default_currency'), 'normal')
  assert.equal(classifyMemory('preferences', 'response_style'), 'normal')
  assert.equal(classifyMemory('preferences', 'preferred_categories'), 'normal')
  assert.equal(classifyMemory('preferences', 'disabled_categories'), 'normal')
  assert.equal(classifyMemory('preferences', 'monthly_income'), 'sensitive')
  assert.equal(classifyMemory('finance', 'monthly_income'), 'sensitive')
  assert.equal(classifyMemory('household', 'members'), 'sensitive')
})

test('normal memory is active while sensitive memory requires explicit confirmation', async () => {
  const db = createFakeDb()
  const repo = createUserMemoryRepository(db)
  const normal = await repo.propose({
    userId: 7,
    namespace: 'preferences',
    memoryKey: 'default_currency',
    value: { code: 'CNY' },
    sessionId: 's-1',
    operationId: 'op-1'
  })
  const pending = await repo.propose({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    value: { amount: 8000, currency: 'CNY' },
    sessionId: 's-1',
    operationId: 'op-2'
  })

  assert.equal(normal.status, 'active')
  assert.equal(pending.status, 'pending')
  assert.deepEqual((await repo.listActive(7)).map(item => item.memoryKey), [
    'default_currency'
  ])

  const active = await repo.confirm({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    expectedVersion: 1,
    operationId: 'op-3'
  })
  assert.equal(active.status, 'active')
  assert.equal(active.version, 2)
})

test('listActive isolates users and filters expired memories', async () => {
  const db = createFakeDb()
  const repo = createUserMemoryRepository(db, {
    now: () => new Date('2026-07-26T00:00:00.000Z')
  })
  await repo.propose({
    userId: 1,
    namespace: 'preferences',
    memoryKey: 'response_style',
    value: { style: 'concise' },
    expiresAt: '2026-07-25T00:00:00.000Z',
    sessionId: 's-1',
    operationId: 'op-1'
  })
  await repo.propose({
    userId: 2,
    namespace: 'preferences',
    memoryKey: 'response_style',
    value: { style: 'detailed' },
    sessionId: 's-2',
    operationId: 'op-2'
  })
  assert.deepEqual(await repo.listActive(1), [])
  assert.equal((await repo.listActive(2))[0].value.style, 'detailed')
  assert.equal(await repo.get(1, 'preferences', 'response_style'), null)
  assert.deepEqual(db.expiryQueries, ['user_memories', 'user_memories', 'user_memories'])
})

test('propose maps only MySQL duplicate insert races to a typed conflict', async () => {
  const input = {
    userId: 7,
    namespace: 'preferences',
    memoryKey: 'response_style',
    value: { style: 'concise' },
    sessionId: 's-1',
    operationId: 'op-1'
  }
  for (const duplicate of [
    Object.assign(new Error('database detail'), { code: 'ER_DUP_ENTRY' }),
    Object.assign(new Error('database detail'), { errno: 1062 })
  ]) {
    const duplicateRepo = createUserMemoryRepository(createFakeDb({
      userMemoryInsertError: duplicate
    }))
    await assert.rejects(
      duplicateRepo.propose(input),
      error => error.code === 'MEMORY_ALREADY_EXISTS' && error.statusCode === 409
    )
  }

  const ordinary = Object.assign(new Error('connection lost'), {
    code: 'PROTOCOL_CONNECTION_LOST'
  })
  const ordinaryRepo = createUserMemoryRepository(createFakeDb({
    userMemoryInsertError: ordinary
  }))
  await assert.rejects(
    ordinaryRepo.propose(input),
    error => error === ordinary
  )
})

test('update applies classification, optimistic locking, and soft delete', async () => {
  const repo = createUserMemoryRepository(createFakeDb())
  await repo.propose({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    value: { amount: 8000 },
    sessionId: 's-1',
    operationId: 'op-1'
  })
  await repo.confirm({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    expectedVersion: 1,
    operationId: 'op-2'
  })
  const pending = await repo.update({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    value: { amount: 9000 },
    expectedVersion: 2,
    sessionId: 's-1',
    operationId: 'op-3'
  })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.version, 3)
  assert.deepEqual(await repo.listActive(7), [])
  await assert.rejects(
    repo.confirm({
      userId: 7,
      namespace: 'finance',
      memoryKey: 'monthly_income',
      expectedVersion: 2,
      operationId: 'op-old'
    }),
    error => error instanceof MemoryVersionConflictError &&
      error.code === 'MEMORY_VERSION_CONFLICT' &&
      error.statusCode === 409
  )
  const deleted = await repo.softDelete({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    expectedVersion: 3,
    operationId: 'op-4'
  })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.version, 4)
})

test('each write audits redacted metadata in the same transaction', async () => {
  const secret = 'salary-is-very-secret'
  const db = createFakeDb()
  const repo = createUserMemoryRepository(db)
  await repo.propose({
    userId: 7,
    namespace: 'finance',
    memoryKey: 'monthly_income',
    value: { secret },
    sessionId: 's-1',
    operationId: 'op-secret'
  })
  const serializedAudit = JSON.stringify(db.state.memory_audit_logs)
  assert.equal(serializedAudit.includes(secret), false)
  assert.equal(serializedAudit.includes('[REDACTED]'), true)
  assert.equal(db.state.memory_audit_logs[0].operation_id, 'op-secret')

  const failingDb = createFakeDb({ failAudit: true })
  await assert.rejects(
    createUserMemoryRepository(failingDb).propose({
      userId: 8,
      namespace: 'preferences',
      memoryKey: 'response_style',
      value: { style: 'concise' },
      sessionId: 's-2',
      operationId: 'op-rollback'
    }),
    /audit unavailable/
  )
  assert.equal(failingDb.state.user_memories.length, 0)
})

test('repository rejects invalid scope and non JSON-safe or oversized values', async () => {
  const repo = createUserMemoryRepository(createFakeDb())
  const base = {
    userId: 7,
    namespace: 'preferences',
    memoryKey: 'response_style',
    sessionId: 's-1',
    operationId: 'op-1'
  }
  await assert.rejects(repo.propose({ ...base, userId: 0, value: {} }), /userId/)
  await assert.rejects(repo.propose({ ...base, namespace: '../finance', value: {} }), /namespace/)
  await assert.rejects(repo.propose({ ...base, memoryKey: 'bad.key', value: {} }), /memoryKey/)
  await assert.rejects(repo.propose({ ...base, operationId: '', value: {} }), /operationId/)
  await assert.rejects(repo.propose({ ...base, value: { bad: undefined } }), /JSON-safe/)
  await assert.rejects(
    repo.propose({ ...base, value: { text: 'x'.repeat(9000) } }),
    /too large/
  )
})
