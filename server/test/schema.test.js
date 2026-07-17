import test from 'node:test'
import assert from 'node:assert/strict'
import { getCreateTableStatements } from '../src/schema.js'

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
