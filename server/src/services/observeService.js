import db from '../db.js'

const PERIODS = {
  '1d': 1,
  '7d': 7,
  '30d': 30
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(normalizeNumber(value) * factor) / factor
}

export function resolvePeriod(period = '30d', now = new Date()) {
  const key = Object.hasOwn(PERIODS, period) ? period : '30d'
  const days = PERIODS[key]
  const since = new Date(now)
  since.setUTCDate(since.getUTCDate() - days)
  return {
    key,
    days,
    since: since.toISOString().slice(0, 19).replace('T', ' ')
  }
}

function filterRows(rows, { userId, since }) {
  return rows.filter(row => {
    if (userId && row.user_id !== userId) return false
    if (since && row.created_at && new Date(row.created_at) < new Date(since)) return false
    return true
  })
}

function groupBy(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const groupKey = row[key] || 'unknown'
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(row)
  }
  return groups
}

function aggregateCalls(rows) {
  const calls = rows.length
  const failures = rows.filter(row => Number(row.success) === 0).length
  const totalCostUsd = round(rows.reduce((sum, row) => sum + normalizeNumber(row.cost_usd), 0), 6)
  const avgLatencyMs = calls
    ? Math.round(rows.reduce((sum, row) => sum + normalizeNumber(row.latency_ms), 0) / calls)
    : 0
  const successRate = calls ? round(((calls - failures) / calls) * 100, 2) : 100
  return { calls, failures, successRate, totalCostUsd, avgLatencyMs }
}

function aggregateBy(rows, key, outputKey) {
  return [...groupBy(rows, key).entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([groupKey, groupRows]) => {
      const summary = aggregateCalls(groupRows)
      return {
        [outputKey]: groupKey,
        calls: summary.calls,
        failures: summary.failures,
        totalCostUsd: summary.totalCostUsd,
        avgLatencyMs: summary.avgLatencyMs
      }
    })
}

function aggregateOcr(rows) {
  const total = rows.length
  const confirmedRows = rows.filter(row => Number(row.user_confirmed) === 1)
  const confirmed = confirmedRows.length
  const corrected = rows.filter(row => Number(row.user_corrected) === 1).length
  const correct = confirmedRows.filter(row => Number(row.ocr_correct) === 1).length
  return {
    total,
    confirmed,
    corrected,
    accuracy: confirmed ? round((correct / confirmed) * 100, 2) : null
  }
}

async function readRows(dbClient, table, { userId, since }) {
  const query = dbClient(table).where({ user_id: userId })
  if (since) query.whereRaw('created_at >= ?', [since])
  return query
}

export async function recordLlmCall({
  userId = null,
  conversationId = null,
  provider = 'local',
  model = 'unknown',
  callType = 'llm',
  inputTokens = 0,
  outputTokens = 0,
  latencyMs = 0,
  costUsd = 0,
  success = true,
  errorMessage = null,
  dbClient = db
}) {
  await dbClient('llm_calls').insert({
    user_id: userId,
    conversation_id: conversationId,
    provider,
    model,
    call_type: callType,
    input_tokens: Math.max(0, Math.floor(normalizeNumber(inputTokens))),
    output_tokens: Math.max(0, Math.floor(normalizeNumber(outputTokens))),
    latency_ms: Math.max(0, Math.floor(normalizeNumber(latencyMs))),
    cost_usd: round(costUsd, 6),
    success: success ? 1 : 0,
    error_message: errorMessage
  })

  return { status: success ? 'succeeded' : 'failed', success: Boolean(success) }
}

export async function recordAgentEvent({
  userId = null,
  callType = 'agent',
  latencyMs = 0,
  success = true,
  errorMessage = null,
  dbClient = db
}) {
  return recordLlmCall({
    userId,
    provider: 'local',
    model: 'agent',
    callType,
    latencyMs,
    success,
    errorMessage,
    dbClient
  })
}

export async function getObserveStats({
  userId,
  period = '30d',
  now = new Date(),
  dbClient = db
} = {}) {
  const resolved = resolvePeriod(period, now)
  const [llmRows, ocrRows] = await Promise.all([
    readRows(dbClient, 'llm_calls', { userId, since: resolved.since }),
    readRows(dbClient, 'ocr_evaluations', { userId, since: resolved.since })
  ])

  const scopedLlmRows = filterRows(llmRows, { userId, since: resolved.since })
  const scopedOcrRows = filterRows(ocrRows, { userId, since: resolved.since })

  return {
    summary: aggregateCalls(scopedLlmRows),
    byType: aggregateBy(scopedLlmRows, 'call_type', 'callType'),
    byProvider: aggregateBy(scopedLlmRows, 'provider', 'provider'),
    ocr: aggregateOcr(scopedOcrRows),
    period: { key: resolved.key, days: resolved.days }
  }
}
