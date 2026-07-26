import test from 'node:test'
import assert from 'node:assert/strict'
import { guardAdminSql } from '../../src/agent/security/sqlGuard.js'

function rejectsSql(sql) {
  assert.throws(
    () => guardAdminSql(sql, { maxRows: 200 }),
    error =>
      error.code === 'ADMIN_SQL_REJECTED' &&
      error.message === 'admin SQL rejected'
  )
}

test('admin SQL guard rejects statements and common parser bypasses', async t => {
  const rejected = [
    'DELETE FROM records',
    'SELECT * FROM records; DROP TABLE users',
    'SELECT * FROM mysql.user',
    'SELECT SLEEP(10)',
    'SELECT * FROM records -- bypass',
    'SELECT * FROM finance_records_safe /* comment */',
    'SELECT BENCHMARK(1000, SHA1("x")) FROM finance_records_safe',
    'SELECT LOAD_FILE("/etc/passwd") FROM finance_records_safe',
    'SELECT * FROM finance_records_safe INTO OUTFILE "/tmp/leak"',
    'UPDATE finance_records_safe SET amount = 0',
    'WITH hidden AS (SELECT * FROM mysql.user) SELECT * FROM hidden',
    'SELECT * FROM (SELECT * FROM mysql.user) hidden',
    'SELECT @@version FROM finance_records_safe'
  ]

  for (const sql of rejected) {
    await t.test(sql.slice(0, 48), () => rejectsSql(sql))
  }
})

test('admin SQL guard only allows the two finance safe views', () => {
  for (const sql of [
    'SELECT * FROM records',
    'SELECT * FROM finance_records_safe JOIN records ON records.id = finance_records_safe.id',
    'SELECT * FROM finance_records_safe UNION SELECT * FROM users'
  ]) {
    rejectsSql(sql)
  }
})

test('admin SQL guard normalizes safe SQL, scopes every source and caps rows', () => {
  const normalized = guardAdminSql(
    'SELECT r.category, SUM(r.amount) AS total FROM finance_records_safe r ' +
      'JOIN finance_budgets_safe b ON b.category = r.category ' +
      'GROUP BY r.category LIMIT 900',
    { maxRows: 200 }
  )

  assert.match(normalized, /FROM `finance_records_safe` AS `r`/)
  assert.match(normalized, /JOIN `finance_budgets_safe` AS `b`/)
  assert.match(normalized, /`r`\.`user_id` = \?/)
  assert.match(normalized, /`b`\.`user_id` = \?/)
  assert.match(normalized, /LIMIT 200$/)
  assert.equal((normalized.match(/\?/g) ?? []).length, 2)
})

test('admin SQL guard preserves a smaller limit and scopes each safe union branch', () => {
  const normalized = guardAdminSql(
    'SELECT user_id, category FROM finance_records_safe LIMIT 10',
    { maxRows: 200 }
  )
  assert.match(normalized, /LIMIT 10$/)

  const union = guardAdminSql(
    'SELECT user_id FROM finance_records_safe ' +
      'UNION ALL SELECT user_id FROM finance_budgets_safe',
    { maxRows: 50 }
  )
  assert.equal((union.match(/`user_id` = \?/g) ?? []).length, 2)
  assert.match(union, /UNION ALL/)
  assert.match(union, /LIMIT 50$/)
})

test('admin SQL guard parenthesizes model OR predicates before trusted user scope', () => {
  const normalized = guardAdminSql(
    'SELECT * FROM finance_records_safe WHERE user_id = 999 OR 1 = 1',
    { maxRows: 20 }
  )

  assert.match(
    normalized,
    /WHERE \(`user_id` = 999 OR 1 = 1\) AND `finance_records_safe`\.`user_id` = \?/
  )
})
