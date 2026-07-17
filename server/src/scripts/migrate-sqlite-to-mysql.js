import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import Database from 'better-sqlite3'
import mysqlDb from '../db-mysql.js'
import { ensureSchema } from '../schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SQLITE_PATH = join(__dirname, '..', '..', 'finance.db')

const TABLES = [
  'users',
  'ledgers',
  'records',
  'record_attachments',
  'budgets',
  'goals',
  'reminders',
  'wechat_subscribe',
  'reports',
  'report_shares',
  'report_templates',
  'exchange_rates',
  'feedback',
  'devices'
]

const TABLE_COLUMNS = {
  users: ['id', 'mini_openid', 'mp_openid', 'unionid', 'phone', 'nickname', 'avatar', 'password', 'username', 'created_at', 'last_login_at'],
  ledgers: ['id', 'user_id', 'name', 'base_currency', 'icon', 'color', 'created_at'],
  records: ['id', 'device_id', 'user_id', 'ledger_id', 'type', 'amount', 'currency', 'amount_cny', 'category', 'description', 'merchant', 'project', 'member', 'date', 'created_at'],
  record_attachments: ['id', 'record_id', 'file_path', 'created_at'],
  budgets: ['id', 'device_id', 'user_id', 'ledger_id', 'category', 'amount', 'period', 'created_at'],
  goals: ['id', 'device_id', 'user_id', 'ledger_id', 'name', 'target_amount', 'current_amount', 'deadline', 'completed', 'created_at'],
  reminders: ['id', 'device_id', 'user_id', 'type', 'title', 'message', 'channel', 'status', 'created_at', 'read_at'],
  wechat_subscribe: ['id', 'user_id', 'openid', 'template_id', 'status', 'authorized_at'],
  reports: ['id', 'user_id', 'ledger_id', 'period_type', 'period_value', 'source', 'summary_json', 'generated_at'],
  report_shares: ['id', 'report_id', 'token', 'expire_at'],
  report_templates: ['id', 'user_id', 'name', 'config_json', 'created_at'],
  exchange_rates: ['id', 'base', 'currency', 'rate', 'fetched_at'],
  feedback: ['id', 'device_id', 'user_id', 'type', 'content', 'image_path', 'priority', 'status', 'admin_reply', 'created_at', 'updated_at'],
  devices: ['device_id', 'first_seen', 'last_seen', 'survey_sent']
}

const DATETIME_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'last_login_at',
  'read_at',
  'authorized_at',
  'generated_at',
  'expire_at',
  'fetched_at',
  'first_seen',
  'last_seen'
])

export function normalizeDateTime(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ')
  const text = String(value).trim()
  if (!text) return null
  return text.slice(0, 19).replace('T', ' ')
}

function pickColumns(row, table) {
  const mapped = {}
  for (const column of TABLE_COLUMNS[table]) {
    if (Object.hasOwn(row, column)) {
      mapped[column] = DATETIME_COLUMNS.has(column) ? normalizeDateTime(row[column]) : row[column]
    }
  }
  return mapped
}

function normalizeJson(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return JSON.stringify(value)
  try {
    JSON.parse(value)
    return value
  } catch {
    return JSON.stringify(value)
  }
}

export function mapRecordRow(row) {
  const mapped = pickColumns(row, 'records')
  mapped.currency = mapped.currency || 'CNY'
  mapped.amount_cny = mapped.amount_cny ?? mapped.amount
  mapped.description = mapped.description || ''
  mapped.type = mapped.type || 'expense'
  return mapped
}

function mapRow(table, row) {
  if (table === 'records') return mapRecordRow(row)
  const mapped = pickColumns(row, table)

  if (table === 'reports') mapped.summary_json = normalizeJson(mapped.summary_json)
  if (table === 'report_templates') mapped.config_json = normalizeJson(mapped.config_json)
  if (table === 'budgets') mapped.period = mapped.period || 'monthly'
  if (table === 'reminders') {
    mapped.status = mapped.status || 'pending'
    mapped.channel = mapped.channel || 'inapp'
  }
  if (table === 'devices') mapped.survey_sent = mapped.survey_sent || 0

  return mapped
}

function readRows(sqlite, table) {
  try {
    return sqlite.prepare(`SELECT * FROM ${table}`).all()
  } catch (error) {
    if (/no such table/i.test(error.message)) return []
    throw error
  }
}

async function upsertRows(db, table, rows) {
  if (!rows.length) return 0
  const conflictKey = table === 'devices' ? 'device_id' : 'id'
  const chunkSize = 100

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    await db(table).insert(chunk).onConflict(conflictKey).merge()
  }

  return rows.length
}

export async function migrateSqliteToMysql({
  sqlitePath = DEFAULT_SQLITE_PATH,
  mysql = mysqlDb
} = {}) {
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found: ${sqlitePath}`)
  }

  await ensureSchema(mysql)
  const sqlite = new Database(sqlitePath, { readonly: true })
  const counts = {}

  try {
    for (const table of TABLES) {
      const rows = readRows(sqlite, table).map(row => mapRow(table, row))
      counts[table] = await upsertRows(mysql, table, rows)
    }
  } finally {
    sqlite.close()
  }

  return counts
}

async function main() {
  const sqlitePath = process.env.SQLITE_PATH || DEFAULT_SQLITE_PATH
  const counts = await migrateSqliteToMysql({ sqlitePath })
  for (const [table, count] of Object.entries(counts)) {
    console.log(`${table}: ${count}`)
  }
  await mysqlDb.destroy()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => {
    console.error(error)
    await mysqlDb.destroy()
    process.exit(1)
  })
}
