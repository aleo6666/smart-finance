import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const db = new Database(join(__dirname, '..', 'finance.db'))

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'expense',
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL,
    current_amount REAL DEFAULT 0,
    deadline TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    completed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(device_id, key)
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    category TEXT,
    amount REAL NOT NULL,
    period TEXT NOT NULL DEFAULT 'monthly',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'daily',
    title TEXT NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    read_at TEXT
  );

  -- 设备表（追踪首次访问时间，用于7日调研触发）
  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    first_seen TEXT DEFAULT (datetime('now','localtime')),
    last_seen TEXT DEFAULT (datetime('now','localtime')),
    survey_sent INTEGER DEFAULT 0
  );

  -- 用户反馈表
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'suggestion',
    content TEXT NOT NULL,
    image_path TEXT,
    priority TEXT DEFAULT 'P2',
    status TEXT DEFAULT 'pending',
    admin_reply TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 汇率数据表
  CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base TEXT NOT NULL DEFAULT 'CNY',
    currency TEXT NOT NULL,
    rate REAL NOT NULL,
    fetched_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_records_device ON records(device_id, date);
  CREATE INDEX IF NOT EXISTS idx_goals_device ON goals(device_id);
  CREATE INDEX IF NOT EXISTS idx_memory_device ON memory(device_id);
  CREATE INDEX IF NOT EXISTS idx_budgets_device ON budgets(device_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_device ON reminders(device_id, status);
  CREATE INDEX IF NOT EXISTS idx_feedback_device ON feedback(device_id, status);
`)

// 设备跟踪：记录或更新设备访问时间
export function trackDevice(deviceId) {
  db.prepare(
    `INSERT INTO devices (device_id, first_seen, last_seen)
     VALUES (?, datetime('now','localtime'), datetime('now','localtime'))
     ON CONFLICT(device_id) DO UPDATE SET last_seen = datetime('now','localtime')`
  ).run(deviceId)
}

// 检查设备是否该收到7日调研（首次访问≥7天且未发送过）
export function shouldSendSurvey(deviceId) {
  const dev = db.prepare(
    `SELECT * FROM devices WHERE device_id = ? AND survey_sent = 0
     AND julianday('now') - julianday(first_seen) >= 7`
  ).get(deviceId)
  return !!dev
}

// 标记调研已发送
export function markSurveySent(deviceId) {
  db.prepare('UPDATE devices SET survey_sent = 1 WHERE device_id = ?').run(deviceId)
}

export default db
