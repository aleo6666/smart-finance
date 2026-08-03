/**
 * 生产运行日志工具
 *
 * 规则：
 * - 不记录密码、密钥、完整手机号、完整 openid
 * - 统一格式：[模块] 操作 | key=value
 * - 支持日志级别控制
 */

const SENSITIVE_KEYS = new Set([
  'authorization',
  'bearer',
  'key',
  'pass',
  'password',
  'secret',
  'smtppass',
  'token',
  'otp',
  'code',
  'verificationcode',
  'apikey'
])
const SENSITIVE_KEY_SUFFIXES = ['secret', 'token', 'apikey', 'password']
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

function cleanString(value) {
  try {
    return String(value ?? '').replace(CONTROL_CHARACTERS, ' ')
  } catch {
    return '****'
  }
}

function mask(value) {
  const s = cleanString(value)
  if (s.length <= 4) return '****'
  return s.slice(0, 2) + '****' + s.slice(-2)
}

function maskEmail(value) {
  let originalEmail
  try {
    originalEmail = String(value ?? '')
  } catch {
    return '****'
  }
  const rawEmail = cleanString(originalEmail)
  if (rawEmail !== originalEmail) return mask(rawEmail)

  const parts = rawEmail.split('@')
  if (parts.length !== 2) return mask(rawEmail)

  const [local, domain] = parts
  const validLocal = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  const validDomain = domain.split('.').every(label =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )
  if (!validLocal || !validDomain) return mask(rawEmail)

  const maskedLocal = local.length === 1
    ? `${local[0]}***`
    : `${local[0]}***${local.at(-1)}`
  return `${maskedLocal}@${domain}`
}

function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === 'errorcode') return false
  return SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

function cleanValue(value, key, seen) {
  if (key && isSensitiveKey(key)) return '***REDACTED***'
  if (key?.toLowerCase() === 'email') return maskEmail(value)
  if ((key === 'phone' || key === 'openid') && typeof value === 'string') {
    return mask(value)
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    let cleaned
    if (Array.isArray(value)) {
      cleaned = value.map(item => cleanValue(item, undefined, seen))
    } else {
      cleaned = {}
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        cleaned[cleanString(nestedKey)] = cleanValue(nestedValue, nestedKey, seen)
      }
    }
    seen.delete(value)
    return cleaned
  }

  if (typeof value === 'string') {
    const cleaned = cleanString(value)
    if (cleaned.includes('@')) return maskEmail(value)
    if (!key && /^\d{6}$/.test(cleaned)) return '***REDACTED***'
    return cleaned
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return cleanString(value)
  }
  return value
}

function cleanObject(obj) {
  if (!obj || typeof obj !== 'object') return obj
  return cleanValue(obj, undefined, new WeakSet())
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function getLevel() {
  if (process.env.NODE_ENV === 'production') return LEVELS.info
  if (process.env.NODE_ENV === 'test') return LEVELS.error
  return LEVELS.debug
}

function formatMessage(level, module, message, extra) {
  const timestamp = new Date().toISOString()
  let line = `[${timestamp}] [${level.toUpperCase()}] [${cleanString(module)}] ${cleanString(message)}`
  if (extra && typeof extra === 'object') {
    const cleaned = cleanObject(extra)
    const pairs = Object.entries(cleaned).map(([k, v]) => {
      const formatted = v && typeof v === 'object' ? JSON.stringify(v) : v
      return `${cleanString(k)}=${formatted}`
    }).join(' | ')
    if (pairs) line += ` | ${pairs}`
  }
  return line
}

export function createLogger(name) {
  return {
    error(message, extra) {
      if (getLevel() >= LEVELS.error) {
        console.error(formatMessage('error', name, message, extra))
      }
    },
    warn(message, extra) {
      if (getLevel() >= LEVELS.warn) {
        console.warn(formatMessage('warn', name, message, extra))
      }
    },
    info(message, extra) {
      if (getLevel() >= LEVELS.info) {
        console.log(formatMessage('info', name, message, extra))
      }
    },
    debug(message, extra) {
      if (getLevel() >= LEVELS.debug) {
        console.log(formatMessage('debug', name, message, extra))
      }
    }
  }
}

export default createLogger
