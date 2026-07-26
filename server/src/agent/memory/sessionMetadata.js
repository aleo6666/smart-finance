import config from '../../config.js'
import { agentRedisCache } from '../../redis.js'
import {
  normalizeTrustedSessionId,
  normalizeTrustedUserId
} from '../runtime.js'

const DEVICE_TYPES = new Set([
  'desktop',
  'miniprogram',
  'mobile',
  'tablet',
  'web',
  'wechat'
])
const INPUT_MODES = new Set(['text', 'voice'])
const RESPONSE_STYLES = new Set(['concise', 'detailed'])

const defaultCache = agentRedisCache

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function trimmed(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).trim().slice(0, maxLength)
}

function normalizeDeviceType(value) {
  const normalized = trimmed(value, 32).toLowerCase()
  return DEVICE_TYPES.has(normalized) ? normalized : 'unknown'
}

function normalizeTimezone(value) {
  const normalized = trimmed(value, 64)
  return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(normalized)
    ? normalized
    : 'Asia/Shanghai'
}

function normalizeLocale(value) {
  const normalized = trimmed(value, 64)
    .split(',')[0]
    .split(';')[0]
    .trim()
    .slice(0, 32)
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)
    ? normalized
    : 'zh-CN'
}

function normalizeAllowlisted(value, allowlist, fallback) {
  const normalized = trimmed(value, 32).toLowerCase()
  return allowlist.has(normalized) ? normalized : fallback
}

export function sanitizeSessionMetadata(value, { now = Date.now } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  const lastActiveAt = Number(source.lastActiveAt)

  return {
    deviceType: normalizeDeviceType(source.deviceType),
    timezone: normalizeTimezone(source.timezone),
    locale: normalizeLocale(source.locale),
    inputMode: normalizeAllowlisted(source.inputMode, INPUT_MODES, 'text'),
    responseStyle: normalizeAllowlisted(
      source.responseStyle,
      RESPONSE_STYLES,
      'concise'
    ),
    lastActiveAt: Number.isSafeInteger(lastActiveAt) && lastActiveAt >= 0
      ? lastActiveAt
      : now()
  }
}

function sessionKey(userId, sessionId) {
  return `agent:session:${normalizeTrustedUserId(userId)}:${normalizeTrustedSessionId(sessionId)}`
}

export function createSessionMetadataStore({
  cache = defaultCache,
  ttlSeconds = config.memory.sessionTtlSeconds,
  now = Date.now
} = {}) {
  positiveInteger(ttlSeconds, 'ttlSeconds')

  return {
    async read(userId, sessionId) {
      const key = sessionKey(userId, sessionId)
      try {
        const value = await cache.get(key)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
        return sanitizeSessionMetadata(value, { now })
      } catch {
        return {}
      }
    },

    async write(userId, sessionId, metadata) {
      const key = sessionKey(userId, sessionId)
      const value = sanitizeSessionMetadata(metadata, { now })
      try {
        await cache.set(key, value, ttlSeconds)
      } catch {
        return null
      }
      return value
    },

    async clear(userId, sessionId) {
      const key = sessionKey(userId, sessionId)
      try {
        await cache.del(key)
        return true
      } catch {
        return false
      }
    }
  }
}

export const createSessionMetadata = createSessionMetadataStore
