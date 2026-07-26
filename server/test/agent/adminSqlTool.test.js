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
    logs: []
  }
  const pool = {
    async query(options) {
      calls.queries.push(options)
      return [rows]
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
    connectionLimit: 1
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
})
