import config from '../../config.js'
import {
  cacheDelete,
  cacheGet,
  cacheSet
} from '../../redis.js'
import {
  normalizeTrustedSessionId,
  normalizeTrustedUserId
} from '../runtime.js'

const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool'])
const MAX_CONTENT_LENGTH = 4000

const defaultCache = {
  get: cacheGet,
  set: cacheSet,
  del: cacheDelete
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function clipCharacters(value, maxLength = MAX_CONTENT_LENGTH) {
  return Array.from(value).slice(0, maxLength).join('')
}

function safeText(value) {
  if (typeof value === 'string') return clipCharacters(value.trim())
  if (typeof value === 'number' || typeof value === 'boolean') {
    return clipCharacters(String(value))
  }
  return ''
}

function safeDatasetRef(value) {
  const candidate = typeof value === 'string'
    ? value
    : value?.datasetRef ?? value?.id
  if (typeof candidate !== 'string') return ''
  const normalized = candidate.trim()
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : ''
}

function sanitizeToolContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return safeText(content)
  }
  const text = safeText(content.text ?? content.summary)
  const datasetRef = safeDatasetRef(content.datasetRef)
  return clipCharacters([
    text,
    datasetRef ? `[datasetRef:${datasetRef}]` : ''
  ].filter(Boolean).join(' '))
}

function sanitizeMessage(message, now) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  if (!MESSAGE_ROLES.has(message.role)) return null

  const numericTs = Number(message.ts)
  return {
    role: message.role,
    content: message.role === 'tool'
      ? sanitizeToolContent(message.content)
      : safeText(message.content),
    ts: Number.isSafeInteger(numericTs) && numericTs >= 0 ? numericTs : now()
  }
}

export function defaultEstimateTokens(text) {
  let nonCjkCharacters = 0
  let cjkTokens = 0
  for (const character of Array.from(String(text))) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)) {
      cjkTokens += 1
    } else if (!/\s/u.test(character)) {
      nonCjkCharacters += 1
    }
  }
  return cjkTokens + Math.ceil(nonCjkCharacters / 4)
}

function countTokens(messages, estimateTokens) {
  return messages.reduce((total, message) => {
    const estimate = Number(estimateTokens(message.content))
    return total + (
      Number.isFinite(estimate) && estimate >= 0
        ? Math.ceil(estimate)
        : defaultEstimateTokens(message.content)
    )
  }, 0)
}

function clipToTokenLimit(message, maxTokens, estimateTokens) {
  const characters = Array.from(message.content)
  let low = 0
  let high = characters.length

  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = characters.slice(0, middle).join('')
    const estimate = Number(estimateTokens(candidate))
    const tokens = Number.isFinite(estimate) && estimate >= 0
      ? Math.ceil(estimate)
      : defaultEstimateTokens(candidate)
    if (tokens <= maxTokens) low = middle
    else high = middle - 1
  }

  return {
    ...message,
    content: characters.slice(0, low).join('')
  }
}

export function trimWindow(messages, {
  maxMessages,
  maxTokens,
  estimateTokens = defaultEstimateTokens,
  now = Date.now
}) {
  positiveInteger(maxMessages, 'maxMessages')
  positiveInteger(maxTokens, 'maxTokens')
  if (typeof estimateTokens !== 'function') {
    throw new TypeError('estimateTokens must be a function')
  }

  const next = (Array.isArray(messages) ? messages : [])
    .map(message => sanitizeMessage(message, now))
    .filter(Boolean)
    .slice(-maxMessages)

  while (next.length > 1 && countTokens(next, estimateTokens) > maxTokens) {
    next.shift()
  }
  if (next.length === 1 && countTokens(next, estimateTokens) > maxTokens) {
    next[0] = clipToTokenLimit(next[0], maxTokens, estimateTokens)
  }
  return next
}

function windowKey(userId, sessionId) {
  return `agent:window:${normalizeTrustedUserId(userId)}:${normalizeTrustedSessionId(sessionId)}`
}

export function createWindowMemory({
  cache = defaultCache,
  maxMessages = config.memory.windowMaxMessages,
  maxTokens = config.memory.windowMaxTokens,
  ttlSeconds = config.memory.sessionTtlSeconds,
  estimateTokens = defaultEstimateTokens,
  now = Date.now
} = {}) {
  positiveInteger(maxMessages, 'maxMessages')
  positiveInteger(maxTokens, 'maxTokens')
  positiveInteger(ttlSeconds, 'ttlSeconds')
  if (typeof estimateTokens !== 'function') {
    throw new TypeError('estimateTokens must be a function')
  }

  const trim = messages => trimWindow(messages, {
    maxMessages,
    maxTokens,
    estimateTokens,
    now
  })

  return {
    async read(userId, sessionId) {
      const key = windowKey(userId, sessionId)
      try {
        const value = await cache.get(key)
        return Array.isArray(value) ? trim(value) : []
      } catch {
        return []
      }
    },

    async append(userId, sessionId, messages) {
      const key = windowKey(userId, sessionId)
      let current = []
      try {
        const value = await cache.get(key)
        if (Array.isArray(value)) current = value
      } catch {
        // A missing window does not block the current request.
      }

      const next = trim([
        ...current,
        ...(Array.isArray(messages) ? messages : [])
      ])
      try {
        await cache.set(key, next, ttlSeconds)
      } catch {
        // Keep serving the bounded in-process value without persisting a backup.
      }
      return next
    },

    async clear(userId, sessionId) {
      const key = windowKey(userId, sessionId)
      try {
        await cache.del(key)
        return true
      } catch {
        return false
      }
    }
  }
}
