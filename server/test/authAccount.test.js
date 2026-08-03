import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAuthAccountService,
  migrateGuestRecords
} from '../src/services/authAccount.js'

function createFakeDatabase(initialState = {}, failures = {}) {
  let committed = structuredClone({
    users: [],
    ledgers: [],
    records: [],
    ...initialState
  })
  const events = []
  let transactionCount = 0

  function matches(row, criteria) {
    return Object.entries(criteria).every(([key, value]) => row[key] === value)
  }

  function createClient(readState, scope) {
    const client = table => {
      let criteria = {}
      const query = {
        where(nextCriteria) {
          criteria = { ...nextCriteria }
          return query
        },
        async first() {
          events.push({ type: 'first', scope, table, where: { ...criteria } })
          const row = readState()[table].find(candidate => matches(candidate, criteria))
          return row ? structuredClone(row) : undefined
        },
        async insert(values) {
          events.push({
            type: 'insert',
            scope,
            table,
            values: structuredClone(values)
          })
          if (failures.insertTable === table) {
            throw new Error(`${table} insert failed`)
          }

          const rows = readState()[table]
          const nextId = rows.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1
          rows.push({ ...structuredClone(values), id: nextId })
          return [nextId]
        },
        async update(values) {
          events.push({
            type: 'update',
            scope,
            table,
            where: { ...criteria },
            values: structuredClone(values)
          })
          let updated = 0
          for (const row of readState()[table]) {
            if (matches(row, criteria)) {
              Object.assign(row, structuredClone(values))
              updated += 1
            }
          }
          return updated
        }
      }
      return query
    }

    client.fn = {
      now() {
        return failures.nowValue || 'database-now'
      }
    }
    return client
  }

  const database = createClient(() => committed, 'outer')
  database.transaction = async work => {
    transactionCount += 1
    events.push({ type: 'transaction:start' })
    if (failures.transaction) {
      events.push({ type: 'transaction:rollback' })
      throw new Error('transaction failed')
    }

    const draft = structuredClone(committed)
    const trx = createClient(() => draft, 'trx')
    try {
      const result = await work(trx)
      committed = draft
      events.push({ type: 'transaction:commit' })
      return result
    } catch (error) {
      events.push({ type: 'transaction:rollback' })
      throw error
    }
  }

  return {
    database,
    events,
    get state() {
      return committed
    },
    get transactionCount() {
      return transactionCount
    }
  }
}

const accountInput = {
  email: 'person@example.com',
  passwordHash: 'hashed-password',
  nickname: 'Person',
  verifiedAt: '2026-08-03T09:00:00.000Z',
  deviceId: 'guest-device'
}

test('createEmailAccount commits the email user and default ledger before migrating matching guest records', async () => {
  const fake = createFakeDatabase({
    records: [
      { id: 1, device_id: 'guest-device', user_id: null },
      { id: 2, device_id: 'other-device', user_id: null },
      { id: 3, device_id: 'guest-device', user_id: 99 }
    ]
  })
  const service = createAuthAccountService(fake.database)

  const userId = await service.createEmailAccount(accountInput)

  assert.equal(userId, 1)
  assert.equal(fake.transactionCount, 1)
  assert.deepEqual(fake.state.users, [{
    id: 1,
    email: 'person@example.com',
    email_verified_at: '2026-08-03T09:00:00.000Z',
    password: 'hashed-password',
    nickname: 'Person'
  }])
  assert.equal('username' in fake.state.users[0], false)
  assert.deepEqual(fake.state.ledgers, [{
    id: 1,
    user_id: 1,
    name: '我的账本',
    base_currency: 'CNY'
  }])
  assert.deepEqual(fake.state.records, [
    { id: 1, device_id: 'guest-device', user_id: 1 },
    { id: 2, device_id: 'other-device', user_id: null },
    { id: 3, device_id: 'guest-device', user_id: 99 }
  ])

  const userInsert = fake.events.find(event => event.type === 'insert' && event.table === 'users')
  const ledgerInsert = fake.events.find(event => event.type === 'insert' && event.table === 'ledgers')
  const migration = fake.events.find(event => event.type === 'update' && event.table === 'records')
  assert.deepEqual(userInsert, {
    type: 'insert',
    scope: 'trx',
    table: 'users',
    values: {
      email: 'person@example.com',
      email_verified_at: '2026-08-03T09:00:00.000Z',
      password: 'hashed-password',
      nickname: 'Person'
    }
  })
  assert.deepEqual(ledgerInsert, {
    type: 'insert',
    scope: 'trx',
    table: 'ledgers',
    values: { user_id: 1, name: '我的账本', base_currency: 'CNY' }
  })
  assert.deepEqual(migration, {
    type: 'update',
    scope: 'outer',
    table: 'records',
    where: { device_id: 'guest-device', user_id: null },
    values: { user_id: 1 }
  })
  assert.ok(
    fake.events.findIndex(event => event.type === 'transaction:commit') <
      fake.events.indexOf(migration)
  )
})

test('createEmailAccount does not add a default ledger when the new user already has one', async () => {
  const fake = createFakeDatabase({
    ledgers: [{ id: 7, user_id: 1, name: '已有账本', base_currency: 'USD' }]
  })

  await createAuthAccountService(fake.database).createEmailAccount(accountInput)

  assert.deepEqual(fake.state.ledgers, [
    { id: 7, user_id: 1, name: '已有账本', base_currency: 'USD' }
  ])
  assert.equal(
    fake.events.some(event => event.type === 'insert' && event.table === 'ledgers'),
    false
  )
  assert.deepEqual(
    fake.events.find(event => event.type === 'first' && event.table === 'ledgers'),
    { type: 'first', scope: 'trx', table: 'ledgers', where: { user_id: 1 } }
  )
})

test('createEmailAccount ignores missing and placeholder device ids', async t => {
  for (const deviceId of [undefined, 'null', 'undefined']) {
    await t.test(String(deviceId), async () => {
      const fake = createFakeDatabase({
        records: [{ id: 1, device_id: deviceId, user_id: null }]
      })

      await createAuthAccountService(fake.database).createEmailAccount({
        ...accountInput,
        deviceId
      })

      assert.equal(
        fake.events.some(event => event.type === 'update' && event.table === 'records'),
        false
      )
      assert.equal(fake.state.records[0].user_id, null)
    })
  }
})

test('createEmailAccount never migrates guest records when account setup rejects', async t => {
  for (const failure of [
    { name: 'transaction', options: { transaction: true } },
    { name: 'user insert', options: { insertTable: 'users' } },
    { name: 'default ledger insert', options: { insertTable: 'ledgers' } }
  ]) {
    await t.test(failure.name, async () => {
      const fake = createFakeDatabase({
        records: [{ id: 1, device_id: 'guest-device', user_id: null }]
      }, failure.options)

      await assert.rejects(
        createAuthAccountService(fake.database).createEmailAccount(accountInput)
      )

      assert.deepEqual(fake.state.records, [
        { id: 1, device_id: 'guest-device', user_id: null }
      ])
      assert.equal(
        fake.events.some(event => event.type === 'update' && event.table === 'records'),
        false
      )
      assert.equal(
        fake.events.some(event => event.type === 'transaction:commit'),
        false
      )
    })
  }
})

test('migrateGuestRecords returns the number of matching records it assigns', async () => {
  const fake = createFakeDatabase({
    records: [
      { id: 1, device_id: 'guest-device', user_id: null },
      { id: 2, device_id: 'guest-device', user_id: null }
    ]
  })

  const updated = await migrateGuestRecords(8, 'guest-device', fake.database)

  assert.equal(updated, 2)
  assert.deepEqual(fake.state.records.map(record => record.user_id), [8, 8])
})

test('findByEmail returns the matching account', async () => {
  const fake = createFakeDatabase({
    users: [
      { id: 4, email: 'other@example.com' },
      { id: 8, email: 'person@example.com' }
    ]
  })

  const user = await createAuthAccountService(fake.database).findByEmail('person@example.com')

  assert.deepEqual(user, { id: 8, email: 'person@example.com' })
})

test('completeLogin records the database time before migrating guest records', async () => {
  const fake = createFakeDatabase({
    users: [{ id: 8, email: 'person@example.com' }],
    records: [{ id: 1, device_id: 'guest-device', user_id: null }]
  }, { nowValue: 'database-time' })

  await createAuthAccountService(fake.database).completeLogin(8, 'guest-device')

  assert.equal(fake.state.users[0].last_login_at, 'database-time')
  assert.equal(fake.state.records[0].user_id, 8)
  const updates = fake.events.filter(event => event.type === 'update')
  assert.deepEqual(updates.map(event => event.table), ['users', 'records'])
})

test('updatePassword changes only the selected account password', async () => {
  const fake = createFakeDatabase({
    users: [
      { id: 8, password: 'old-hash' },
      { id: 9, password: 'other-hash' }
    ]
  })

  const updated = await createAuthAccountService(fake.database).updatePassword(8, 'new-hash')

  assert.equal(updated, 1)
  assert.deepEqual(fake.state.users, [
    { id: 8, password: 'new-hash' },
    { id: 9, password: 'other-hash' }
  ])
})
