import db from '../db.js'

const VALID_SOURCES = new Set(['all', 'ocr', 'insight'])
const MONTH_PATTERN = /^\d{4}-\d{2}$/

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

function normalizeMonth(month) {
  return MONTH_PATTERN.test(String(month || '')) ? String(month) : currentMonth()
}

function normalizeSource(source) {
  return VALID_SOURCES.has(source) ? source : 'all'
}

function safeJsonParse(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || '{}'))
  } catch {
    return { raw: String(value || '') }
  }
}

function stringify(value) {
  return JSON.stringify(value, null, 0)
}

function applyOcrCorrection(original, row) {
  const payload = safeJsonParse(original)
  const records = Array.isArray(payload.records) ? payload.records : [payload]
  const first = records[0] || {}
  return {
    records: [{
      ...first,
      category: row.corrected_category || first.category || '其他',
      amount: row.corrected_amount != null ? Number(row.corrected_amount) : first.amount
    }]
  }
}

function createOcrItem(row, month) {
  const original = safeJsonParse(row.ocr_result)
  return {
    source: 'ocr',
    messages: [
      { role: 'user', content: '请识别以下小票图片中的账单条目' },
      { role: 'assistant', content: stringify(original) },
      { role: 'user', content: `用户修正：分类应为「${row.corrected_category || '其他'}」，金额应为 ${row.corrected_amount ?? '未提供'} 元` },
      { role: 'assistant', content: stringify(applyOcrCorrection(row.ocr_result, row)) }
    ],
    metadata: {
      userId: row.user_id,
      recordId: row.record_id || null,
      evaluationId: row.id,
      month
    }
  }
}

function createInsightItem(row, month) {
  const content = safeJsonParse(row.content)
  const isAccurate = content.isAccurate === true
  const summary = content.context?.summary || content.insightId || 'AI insight'
  const correction = content.correction || content.raw || ''

  return {
    source: 'insight',
    messages: [
      { role: 'user', content: `原洞察：${summary}\n用户反馈：${correction || (isAccurate ? '准确' : '不准确')}` },
      { role: 'assistant', content: isAccurate ? '该洞察被用户确认准确。' : '已收到修正，并在后续分析中避免该判断。' }
    ],
    metadata: {
      userId: row.user_id,
      feedbackId: row.id,
      priority: row.priority || null,
      month
    }
  }
}

async function fetchOcrRows({ userId, month, dbClient }) {
  return dbClient('ocr_evaluations')
    .where({ user_id: userId, user_corrected: 1 })
    .whereRaw("DATE_FORMAT(COALESCE(confirmed_at, created_at), '%Y-%m') = ?", [month])
    .orderBy('created_at', 'desc')
}

async function fetchInsightRows({ userId, month, dbClient }) {
  return dbClient('feedback')
    .where({ user_id: userId, type: 'ai_insight' })
    .whereRaw("DATE_FORMAT(created_at, '%Y-%m') = ?", [month])
    .orderBy('created_at', 'desc')
}

export async function buildBadCaseDataset({
  userId,
  month = currentMonth(),
  source = 'all',
  dbClient = db
} = {}) {
  if (!userId) return []
  const normalizedMonth = normalizeMonth(month)
  const normalizedSource = normalizeSource(source)
  const items = []

  if (normalizedSource === 'all' || normalizedSource === 'ocr') {
    const rows = await fetchOcrRows({ userId, month: normalizedMonth, dbClient })
    items.push(...rows.map(row => createOcrItem(row, normalizedMonth)))
  }

  if (normalizedSource === 'all' || normalizedSource === 'insight') {
    const rows = await fetchInsightRows({ userId, month: normalizedMonth, dbClient })
    items.push(...rows.map(row => createInsightItem(row, normalizedMonth)))
  }

  return items
}

export function toJsonl(items) {
  return items.map(item => JSON.stringify(item)).join('\n')
}
