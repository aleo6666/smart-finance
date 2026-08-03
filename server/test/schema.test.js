import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureUserEmailSchema, getCreateTableStatements } from '../src/schema.js'

function getTableStatement(tableName) {
  return getCreateTableStatements().find((statement) =>
    statement.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`)
  )
}

function createUserEmailSchemaDb({ columns = [], indexes = [] } = {}) {
  const existingColumns = new Set(columns)
  const existingIndexes = new Set(indexes)
  const operations = []

  return {
    operations,
    db: {
      schema: {
        async hasColumn(tableName, columnName) {
          assert.equal(tableName, 'users')
          return existingColumns.has(columnName)
        },
        async alterTable(tableName, callback) {
          assert.equal(tableName, 'users')
          callback({
            string(columnName, length) {
              operations.push(['string', columnName, length])
              existingColumns.add(columnName)
              return { nullable() {} }
            },
            dateTime(columnName) {
              operations.push(['dateTime', columnName])
              existingColumns.add(columnName)
              return { nullable() {} }
            },
            unique(columnNames, indexName) {
              operations.push(['unique', columnNames, indexName])
              existingIndexes.add(indexName)
            }
          })
        }
      },
      async raw(sql) {
        assert.equal(sql, "SHOW INDEX FROM users WHERE Key_name = 'uniq_users_email'")
        return [[...existingIndexes].map((Key_name) => ({ Key_name })), []]
      }
    }
  }
}

test('users schema defines verified email identity fields and unique index', () => {
  const usersSql = getTableStatement('users')

  assert.ok(usersSql)
  assert.match(usersSql, /email\s+VARCHAR\(254\)/)
  assert.match(usersSql, /email_verified_at\s+DATETIME NULL/)
  assert.match(usersSql, /UNIQUE KEY uniq_users_email \(email\)/)
})

test('ensureUserEmailSchema adds missing email schema once', async () => {
  const { db, operations } = createUserEmailSchemaDb({
    columns: ['email_verified_at']
  })

  await ensureUserEmailSchema(db)

  assert.deepEqual(operations, [
    ['string', 'email', 254],
    ['unique', ['email'], 'uniq_users_email']
  ])

  operations.length = 0
  await ensureUserEmailSchema(db)

  assert.deepEqual(operations, [])
})

test('schema contains core and phase 1 tables', () => {
  const sql = getCreateTableStatements().join('\n')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ledgers/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS records/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reminders/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_tasks/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS llm_calls/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ocr_evaluations/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cost_alert_rules/)
})

test('schema defines agent task status fields', () => {
  const sql = getCreateTableStatements().join('\n')

  assert.match(sql, /task_id\s+VARCHAR\(64\)/)
  assert.match(sql, /agent_type\s+VARCHAR\(32\)/)
  assert.match(sql, /status\s+VARCHAR\(16\)/)
  assert.match(sql, /payload_json\s+JSON/)
  assert.match(sql, /result_json\s+JSON/)
})

test('schema contains agent memory and idempotency tables', () => {
  const sql = getCreateTableStatements().join('\n')
  const requiredClauses = [
    ['user_roles table', /CREATE TABLE IF NOT EXISTS user_roles/],
    ['user_memories table', /CREATE TABLE IF NOT EXISTS user_memories/],
    ['memory_audit_logs table', /CREATE TABLE IF NOT EXISTS memory_audit_logs/],
    ['conversation_summaries table', /CREATE TABLE IF NOT EXISTS conversation_summaries/],
    ['agent_operations table', /CREATE TABLE IF NOT EXISTS agent_operations/],
    ['user memory uniqueness', /UNIQUE KEY uniq_user_memory \(user_id, namespace, memory_key\)/],
    ['agent operation uniqueness', /UNIQUE KEY uniq_agent_operation \(user_id, operation_id\)/]
  ]
  const missingClauses = requiredClauses
    .filter(([, pattern]) => !pattern.test(sql))
    .map(([name]) => name)

  assert.deepEqual(missingClauses, [])
})

test('schema defines L2 user memory fields and indexes', () => {
  const rolesSql = getTableStatement('user_roles')
  const memoriesSql = getTableStatement('user_memories')

  assert.ok(rolesSql)
  assert.match(rolesSql, /user_id\s+BIGINT UNSIGNED PRIMARY KEY/)
  assert.match(rolesSql, /role\s+VARCHAR\(32\) NOT NULL DEFAULT 'user'/)
  assert.match(rolesSql, /updated_at\s+DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/)

  assert.ok(memoriesSql)
  assert.match(memoriesSql, /value_json\s+JSON NOT NULL/)
  assert.match(memoriesSql, /sensitivity\s+VARCHAR\(16\) NOT NULL DEFAULT 'normal'/)
  assert.match(memoriesSql, /status\s+VARCHAR\(16\) NOT NULL DEFAULT 'active'/)
  assert.match(memoriesSql, /source_type\s+VARCHAR\(16\) NOT NULL/)
  assert.match(memoriesSql, /source_session_id\s+VARCHAR\(128\) NULL/)
  assert.match(memoriesSql, /version\s+INT UNSIGNED NOT NULL DEFAULT 1/)
  assert.match(memoriesSql, /confirmed_at\s+DATETIME NULL/)
  assert.match(memoriesSql, /expires_at\s+DATETIME NULL/)
  assert.match(memoriesSql, /UNIQUE KEY uniq_user_memory \(user_id, namespace, memory_key\)/)
  assert.match(memoriesSql, /KEY idx_user_memories_active \(user_id, status, expires_at\)/)
})

test('schema defines memory audit and L3 summary fields and indexes', () => {
  const auditSql = getTableStatement('memory_audit_logs')
  const summariesSql = getTableStatement('conversation_summaries')

  assert.ok(auditSql)
  assert.match(auditSql, /before_json\s+JSON NULL/)
  assert.match(auditSql, /after_json\s+JSON NULL/)
  assert.match(auditSql, /operation_id\s+VARCHAR\(64\) NOT NULL/)
  assert.match(auditSql, /KEY idx_memory_audit_user_created \(user_id, created_at\)/)

  assert.ok(summariesSql)
  assert.match(summariesSql, /summary_json\s+JSON NOT NULL/)
  assert.match(summariesSql, /covered_until_turn\s+INT UNSIGNED NOT NULL DEFAULT 0/)
  assert.match(summariesSql, /message_count\s+INT UNSIGNED NOT NULL DEFAULT 0/)
  assert.match(summariesSql, /expires_at\s+DATETIME NOT NULL/)
  assert.match(summariesSql, /UNIQUE KEY uniq_conversation_summary \(user_id, session_id\)/)
  assert.match(summariesSql, /KEY idx_conversation_summaries_expiry \(expires_at\)/)
})

test('schema defines idempotent agent operation fields and index', () => {
  const operationsSql = getTableStatement('agent_operations')

  assert.ok(operationsSql)
  assert.match(operationsSql, /status\s+VARCHAR\(16\) NOT NULL DEFAULT 'started'/)
  assert.match(operationsSql, /input_hash\s+CHAR\(64\) NOT NULL/)
  assert.match(operationsSql, /result_json\s+JSON NULL/)
  assert.match(operationsSql, /error_code\s+VARCHAR\(64\) NULL/)
  assert.match(operationsSql, /UNIQUE KEY uniq_agent_operation \(user_id, operation_id\)/)
})
