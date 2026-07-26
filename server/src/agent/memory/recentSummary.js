import config from '../../config.js'
import {
  normalizeTrustedSessionId,
  normalizeTrustedUserId
} from '../runtime.js'

const LIST_FIELDS = Object.freeze([
  'currentTopics',
  'recentReferences',
  'unfinishedTasks',
  'analysisConclusions',
  'plannedActions'
])
const TEMPORARY_FIELDS = Object.freeze([
  'currentMonth',
  'currentLedgerId',
  'currentCategory'
])
const MAX_LIST_ITEMS = 8
const MAX_ITEM_LENGTH = 256
const MAX_SUMMARY_BYTES = 8192
const MAX_COUNTER = 1_000_000

export function emptySummary() {
  return {
    currentTopics: [],
    recentReferences: [],
    unfinishedTasks: [],
    analysisConclusions: [],
    plannedActions: [],
    temporaryContext: {}
  }
}

function safeString(value, maxLength = MAX_ITEM_LENGTH) {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    return ''
  }
  return Array.from(String(value).trim()).slice(0, maxLength).join('')
}

function sanitizeList(value) {
  if (!Array.isArray(value)) return []
  const result = []
  const seen = new Set()
  for (const item of value) {
    const normalized = safeString(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length === MAX_LIST_ITEMS) break
  }
  return result
}

function sanitizeTemporaryContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const key of TEMPORARY_FIELDS) {
    if (key === 'currentLedgerId' && Number.isSafeInteger(value[key])) {
      result[key] = value[key]
      continue
    }
    const normalized = safeString(value[key])
    if (normalized) result[key] = normalized
  }
  return result
}

export function sanitizeSummary(input = {}) {
  const safeInput = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {}
  const result = emptySummary()
  result.temporaryContext = sanitizeTemporaryContext(safeInput.temporaryContext)
  for (const field of LIST_FIELDS) {
    for (const item of sanitizeList(safeInput[field])) {
      result[field].push(item)
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SUMMARY_BYTES) {
        result[field].pop()
        break
      }
    }
  }
  return result
}

function boundedCounter(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.min(MAX_COUNTER, Math.floor(numeric))
}

function parseSummary(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? value : null
}

function positiveRetentionDays(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 365) {
    throw new TypeError('retentionDays must be an integer between 1 and 365')
  }
  return value
}

export function createRecentSummaryRepository(db, {
  retentionDays = config.memory.summaryRetentionDays,
  now = () => new Date()
} = {}) {
  if (typeof db !== 'function' || typeof db.fn?.now !== 'function') {
    throw new TypeError('db must be a Knex client')
  }
  const days = positiveRetentionDays(retentionDays)

  return {
    async read(userId, sessionId) {
      const trustedUserId = normalizeTrustedUserId(userId)
      const trustedSessionId = normalizeTrustedSessionId(sessionId)
      const row = await db('conversation_summaries')
        .where({
          user_id: trustedUserId,
          session_id: trustedSessionId
        })
        .where(expiry => expiry.where('expires_at', '>', db.fn.now()))
        .first()

      const expiresAt = row?.expires_at == null
        ? Number.NaN
        : new Date(row.expires_at).getTime()
      if (!row || !Number.isFinite(expiresAt) || expiresAt <= now().getTime()) {
        return emptySummary()
      }
      const parsed = parseSummary(row.summary_json)
      return parsed ? sanitizeSummary(parsed) : emptySummary()
    },

    async upsert({
      userId,
      sessionId,
      summary,
      coveredUntilTurn = 0,
      messageCount = 0
    }) {
      const trustedUserId = normalizeTrustedUserId(userId)
      const trustedSessionId = normalizeTrustedSessionId(sessionId)
      const sanitized = sanitizeSummary(summary)
      const writtenAt = now()
      const expiresAt = new Date(writtenAt.getTime() + days * 86_400_000)
      const row = {
        user_id: trustedUserId,
        session_id: trustedSessionId,
        summary_json: JSON.stringify(sanitized),
        covered_until_turn: boundedCounter(coveredUntilTurn),
        message_count: boundedCounter(messageCount),
        expires_at: expiresAt,
        updated_at: writtenAt
      }

      await db('conversation_summaries')
        .insert(row)
        .onConflict(['user_id', 'session_id'])
        .merge([
          'summary_json',
          'covered_until_turn',
          'message_count',
          'expires_at',
          'updated_at'
        ])
      return sanitized
    }
  }
}
