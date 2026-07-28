import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSqlTool } from '../../src/agent/tools/adminSqlTool.js'

const safeSql =
  'SELECT category, SUM(amount) AS total FROM finance_records_safe GROUP BY category'

function fixture({
  runtime = {
    userId: 7,
    requestId: 'request-7',
    isAdmin: true
  },
  enabled = true,
  context = {
    userId: 7,
    requestId: 'request-7',
    isAdmin: true,
    intentType: 'analysis',
    domainGap: 'unsupported_depth'
  },
  rows = [{ category: 'food', total: 25, private_note: 'never-return' }]
} = {}) {
  const calls = {
    poolOptions: [],
    queries: [],
    datasets: [],
    logs: [],
    ends: 0
  }
  const pool = {
    async query(options) {
      calls.queries.push(options)
      return [rows]
    },
    async end() {
      calls.ends += 1
    }
  }
  const config = {
    agent: { adminSqlEnabled: enabled },
    adminSql: {
      host: 'readonly-db.internal',
      port: 3306,
      name: 'smart_finance',
      user: 'finance_readonly',
      password: 'db-password-must-not-leak',
      maxRows: 20,
      timeoutMs: 1234
    }
  }
  const adminSqlTool = createAdminSqlTool({
    runtime,
    config,
    datasetStore: {
      async put(input) {
        calls.datasets.push(input)
        return {
          datasetRef: 'ds_admin',
          count: input.rows.length,
          scope: input.scope
        }
      }
    },
    createPool(options) {
      calls.poolOptions.push(options)
      return pool
    },
    logger: {
      info(message, extra) { calls.logs.push(['info', message, extra]) },
      warn(message, extra) { calls.logs.push(['warn', message, extra]) }
    }
  })

  return {
    adminSqlTool,
    calls,
    context
  }
}

test('admin SQL tool requires all trusted privilege and routing gates', async t => {
  const cases = [
    {
      name: 'ordinary user',
      runtime: { userId: 7, requestId: 'request-7', isAdmin: false }
    },
    {
      name: 'feature disabled',
      enabled: false
    },
    {
      name: 'non-analysis intent',
      context: {
        userId: 7,
        requestId: 'request-7',
        isAdmin: true,
        intentType: 'query',
        domainGap: 'unsupported_depth'
      }
    },
    {
      name: 'no domain gap',
      context: {
        userId: 7,
        requestId: 'request-7',
        isAdmin: true,
        intentType: 'analysis'
      }
    }
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { adminSqlTool, calls, context } = fixture(item)
      await assert.rejects(
        adminSqlTool.invoke({ sql: safeSql }, { context }),
        error => error.code === 'FORBIDDEN' && error.message === 'forbidden'
      )
      assert.equal(calls.queries.length, 0)
      assert.equal(calls.datasets.length, 0)
      assert.equal(calls.poolOptions.length, 0)
    })
  }
})

test('admin SQL tool uses read-only config, trusted user scope and request dataset ownership', async () => {
  const { adminSqlTool, calls, context } = fixture()

  const result = await adminSqlTool.invoke({ sql: safeSql }, { context })

  assert.deepEqual(calls.poolOptions, [{
    host: 'readonly-db.internal',
    port: 3306,
    database: 'smart_finance',
    user: 'finance_readonly',
    password: 'db-password-must-not-leak',
    connectionLimit: 1,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  }])
  assert.equal(calls.queries.length, 1)
  assert.equal(calls.queries[0].timeout, 1234)
  assert.deepEqual(calls.queries[0].values, [7])
  assert.match(calls.queries[0].sql, /`user_id` = \?/)
  assert.match(calls.queries[0].sql, /LIMIT 20$/)
  assert.deepEqual(calls.datasets, [{
    userId: 7,
    requestId: 'request-7',
    rows: [{ category: 'food', total: 25, private_note: 'never-return' }],
    summary: {
      source: 'admin_read_only_sql',
      rowCount: 1
    },
    scope: { queryKind: 'admin_analysis' }
  }])
  assert.deepEqual(result, {
    datasetRef: 'ds_admin',
    count: 1,
    scope: { queryKind: 'admin_analysis' }
  })
  assert.doesNotMatch(JSON.stringify(result), /food|25|private_note/)
  assert.equal(calls.ends, 1)
})

test('admin SQL logs contain only hash, row count, duration and stable code', async () => {
  const { adminSqlTool, calls, context } = fixture()
  await adminSqlTool.invoke({ sql: safeSql }, { context })

  const serialized = JSON.stringify(calls.logs)
  assert.match(serialized, /sqlTemplateHash/)
  assert.match(serialized, /rowCount/)
  assert.match(serialized, /durationMs/)
  assert.doesNotMatch(serialized, /SELECT|category|food|never-return|db-password/)
})

test('admin SQL guard and database failures expose stable errors without internals', async () => {
  const rejected = fixture()
  await assert.rejects(
    rejected.adminSqlTool.invoke(
      { sql: 'SELECT * FROM mysql.user' },
      { context: rejected.context }
    ),
    error =>
      error.code === 'ADMIN_SQL_REJECTED' &&
      !error.message.includes('mysql.user')
  )

  const calls = []
  const tool = createAdminSqlTool({
    runtime: { userId: 7, requestId: 'request-7', isAdmin: true },
    config: {
      agent: { adminSqlEnabled: true },
      adminSql: {
        user: 'finance_readonly',
        password: 'db-secret',
        maxRows: 20,
        timeoutMs: 1000
      }
    },
    datasetStore: { async put() { assert.fail('must not persist') } },
    createPool() {
      return {
        async query() {
          throw new Error('connect ECONNREFUSED password=db-secret')
        },
        async end() {
          calls.push(['end'])
        }
      }
    },
    logger: {
      info() {},
      warn(message, extra) { calls.push([message, extra]) }
    }
  })
  await assert.rejects(
    tool.invoke({ sql: safeSql }, { context: rejected.context }),
    error =>
      error.code === 'ADMIN_SQL_UNAVAILABLE' &&
      error.message === 'admin SQL unavailable'
  )
  assert.doesNotMatch(JSON.stringify(calls), /ECONNREFUSED|db-secret|SELECT/)
  assert.equal(calls.filter(item => item[0] === 'end').length, 1)
})

test('admin SQL normalizes Date and bigint rows without losing precision', async () => {
  const occurredAt = new Date('2026-07-27T08:09:10.123Z')
  const exactAmount = 900719925474099312345n
  const { adminSqlTool, calls, context } = fixture({
    rows: [{
      occurredAt,
      exactAmount,
      decimalAmount: '12345678901234567890.123456'
    }]
  })

  await adminSqlTool.invoke({ sql: safeSql }, { context })

  assert.deepEqual(calls.datasets[0].rows, [{
    occurredAt: '2026-07-27T08:09:10.123Z',
    exactAmount: '900719925474099312345',
    decimalAmount: '12345678901234567890.123456'
  }])
  assert.equal(calls.ends, 1)
})

test('owned pools close once after dataset failure without replacing the safe error', async () => {
  let ends = 0
  const tool = createAdminSqlTool({
    runtime: { userId: 7, requestId: 'request-7', isAdmin: true },
    config: {
      agent: { adminSqlEnabled: true },
      adminSql: {
        user: 'finance_readonly',
        password: 'db-secret',
        maxRows: 20,
        timeoutMs: 1000
      }
    },
    datasetStore: {
      async put() {
        throw new Error('redis password=secret')
      }
    },
    createPool() {
      return {
        async query() {
          return [[{ total: '25.00' }]]
        },
        async end() {
          ends += 1
          throw new Error('close password=secret')
        }
      }
    },
    logger: { info() {}, warn() {} }
  })
  const context = {
    userId: 7,
    requestId: 'request-7',
    isAdmin: true,
    intentType: 'analysis',
    domainGap: 'unsupported_depth'
  }

  await assert.rejects(
    tool.invoke({ sql: safeSql }, { context }),
    error =>
      error.code === 'ADMIN_SQL_UNAVAILABLE' &&
      !error.message.includes('redis') &&
      !error.message.includes('close')
  )
  assert.equal(ends, 1)
})

test('an externally injected pool is never closed by the tool', async () => {
  let ends = 0
  const externalPool = {
    async query() {
      return [[{ total: '25.00' }]]
    },
    async end() {
      ends += 1
    }
  }
  const tool = createAdminSqlTool({
    runtime: { userId: 7, requestId: 'request-7', isAdmin: true },
    config: {
      agent: { adminSqlEnabled: true },
      adminSql: {
        user: 'finance_readonly',
        password: 'db-secret',
        maxRows: 20,
        timeoutMs: 1000
      }
    },
    datasetStore: {
      async put(input) {
        return {
          datasetRef: 'ds_external',
          count: input.rows.length,
          scope: input.scope
        }
      }
    },
    pool: externalPool,
    createPool() {
      assert.fail('must not create an owned pool')
    },
    logger: { info() {}, warn() {} }
  })
  const context = {
    userId: 7,
    requestId: 'request-7',
    isAdmin: true,
    intentType: 'analysis',
    domainGap: 'unsupported_depth'
  }

  const result = await tool.invoke({ sql: safeSql }, { context })

  assert.equal(result.datasetRef, 'ds_external')
  assert.equal(ends, 0)
})

test('non-plain SQL row values fail closed and release the owned pool', async () => {
  class UnsafeRow {
    constructor() {
      this.total = '25.00'
    }
  }
  const { adminSqlTool, calls, context } = fixture({
    rows: [new UnsafeRow()]
  })

  await assert.rejects(
    adminSqlTool.invoke({ sql: safeSql }, { context }),
    error => error.code === 'ADMIN_SQL_UNAVAILABLE'
  )
  assert.equal(calls.datasets.length, 0)
  assert.equal(calls.ends, 1)
})

test('owned pool close errors do not replace a successful result', async () => {
  let ends = 0
  const tool = createAdminSqlTool({
    runtime: { userId: 7, requestId: 'request-7', isAdmin: true },
    config: {
      agent: { adminSqlEnabled: true },
      adminSql: {
        user: 'finance_readonly',
        password: 'db-secret',
        maxRows: 20,
        timeoutMs: 1000
      }
    },
    datasetStore: {
      async put(input) {
        return {
          datasetRef: 'ds_close_error',
          count: input.rows.length,
          scope: input.scope
        }
      }
    },
    createPool() {
      return {
        async query() {
          return [[{ total: '25.00' }]]
        },
        end() {
          ends += 1
          throw new Error('close password=db-secret')
        }
      }
    },
    logger: { info() {}, warn() {} }
  })
  const context = {
    userId: 7,
    requestId: 'request-7',
    isAdmin: true,
    intentType: 'analysis',
    domainGap: 'unsupported_depth'
  }

  const result = await tool.invoke({ sql: safeSql }, { context })

  assert.equal(result.datasetRef, 'ds_close_error')
  assert.equal(ends, 1)
})
