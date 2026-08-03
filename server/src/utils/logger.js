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
  'smtppass',
  'otp',
  'code',
  'verificationcode'
])
const SENSITIVE_KEY_FRAGMENTS = ['password', 'secret', 'token', 'key']

function mask(value) {
  const s = String(value)
  if (s.length <= 4) return '****'
  return s.slice(0, 2) + '****' + s.slice(-2)
}

function maskEmail(value) {
  let email
  try {
    email = String(value ?? '')
  } catch {
    return '****'
  }

  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return mask(email)

  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const maskedLocal = local.length === 1
    ? `${local[0]}***`
    : `${local[0]}***${local.at(-1)}`
  return `${maskedLocal}@${domain}`
}

function isSensitiveKey(key) {
  const lower = key.toLowerCase()
  const normalized = lower.replace(/[_-]/g, '')
  if (normalized === 'errorcode') return false
  return SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_KEY_FRAGMENTS.some(fragment => lower.includes(fragment))
}

function cleanObject(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const cleaned = { ...obj }
  for (const key of Object.keys(cleaned)) {
    if (isSensitiveKey(key)) {
      cleaned[key] = '***REDACTED***'
    } else if (key.toLowerCase() === 'email') {
      cleaned[key] = maskEmail(cleaned[key])
    } else if (key === 'phone' && typeof cleaned[key] === 'string') {
      cleaned[key] = mask(cleaned[key])
    } else if (key === 'openid' && typeof cleaned[key] === 'string') {
      cleaned[key] = mask(cleaned[key])
    } else if (typeof cleaned[key] === 'string' && cleaned[key].length > 80 && isSensitiveKey(key)) {
      cleaned[key] = '***REDACTED***'
    }
  }
  return cleaned
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function getLevel() {
  if (process.env.NODE_ENV === 'production') return LEVELS.info
  if (process.env.NODE_ENV === 'test') return LEVELS.error
  return LEVELS.debug
}

function formatMessage(level, module, message, extra) {
  const timestamp = new Date().toISOString()
  let line = `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}`
  if (extra && typeof extra === 'object') {
    const cleaned = cleanObject(extra)
    const pairs = Object.entries(cleaned).map(([k, v]) => `${k}=${v}`).join(' | ')
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
