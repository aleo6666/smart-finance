import { createHmac, randomInt } from 'node:crypto'

const CODE_TTL = 300
const COOLDOWN_TTL = 60
const RATE_TTL = 3600
const MAX_ATTEMPTS = 5
const MAX_EMAIL_SENDS = 5
const MAX_IP_SENDS = 20
const LOGIN_LOCK_TTL = 900

const INVALID_CODE_RESULT = Object.freeze({
  success: false,
  message: '验证码无效或已过期'
})

const RATE_SCRIPT = [
  '-- email-verification:rate-limit',
  "local current = redis.call('INCR', KEYS[1])",
  "if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
  'return current'
].join('\n')

const CONSUME_SCRIPT = [
  '-- email-verification:consume',
  "local stored = redis.call('GET', KEYS[1])",
  'if not stored then return 0 end',
  "local attempts = redis.call('INCR', KEYS[2])",
  "redis.call('EXPIRE', KEYS[2], ARGV[2])",
  'if attempts > tonumber(ARGV[3]) then',
  "  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
  '  return -2',
  'end',
  'if stored ~= ARGV[1] then',
  '  if attempts >= tonumber(ARGV[3]) then',
  "    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
  '  end',
  '  return -1',
  'end',
  "redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
  'return 1'
].join('\n')

const LOGIN_FAILURE_SCRIPT = [
  '-- email-verification:login-failure',
  "local current = redis.call('INCR', KEYS[1])",
  "redis.call('EXPIRE', KEYS[1], ARGV[1])",
  'return current'
].join('\n')

export class EmailVerificationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EmailVerificationError'
    this.code = code
  }
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function isValidEmail(value) {
  const email = normalizeEmail(value)
  if (!email || email.length > 254) return false

  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || local.length > 64 || !domain || domain.length > 253) return false
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false

  const labels = domain.split('.')
  return labels.length >= 2 && labels.every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )
}

export function maskEmail(value) {
  const email = normalizeEmail(value)
  if (!isValidEmail(email)) return '***'
  const [local, domain] = email.split('@')
  if (local.length === 1) return `${local}***@${domain}`
  return `${local[0]}***${local.at(-1)}@${domain}`
}

export function createEmailVerificationService({
  getRedis,
  secret,
  mailer,
  randomIntFn = randomInt
}) {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('Email verification secret is required')
  }

  const digest = value => createHmac('sha256', secret).update(value).digest('hex')
  const emailIdentity = email => digest(`email:${normalizeEmail(email)}`)
  const emailKey = (kind, purpose, identity) => `email:${kind}:${purpose}:${identity}`
  const rateAddressKey = identity => `email:rate:address:${identity}`
  const rateIpKey = ip => `email:rate:ip:${digest(`ip:${String(ip ?? 'unknown')}`)}`
  const loginKey = identity => `login:lock:email:${identity}`
  const otpDigest = (purpose, identity, code) => digest(`otp:${purpose}:${identity}:${code}`)

  const unavailable = () => new EmailVerificationError(
    'service_unavailable',
    '验证服务暂时不可用，请稍后重试'
  )

  async function redisClient() {
    try {
      const redis = await getRedis()
      if (!redis || typeof redis !== 'object') throw new Error('Invalid Redis client')
      if (redis.status === 'wait') await redis.connect()
      return redis
    } catch {
      throw unavailable()
    }
  }

  async function redisOperation(operation) {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof EmailVerificationError) throw error
      throw unavailable()
    }
  }

  async function safeDelete(redis, ...keys) {
    try {
      await redis.del(...keys)
    } catch {
      // Cleanup is best effort; the original fixed error remains authoritative.
    }
  }

  function validateIdentity(email) {
    const normalized = normalizeEmail(email)
    if (!isValidEmail(normalized)) {
      throw new EmailVerificationError('invalid_email', '邮箱格式不正确')
    }
    return { normalized, identity: emailIdentity(normalized) }
  }

  function isValidPurpose(purpose) {
    return purpose === 'register' || purpose === 'reset'
  }

  async function enforceRate(redis, key, maximum) {
    const rawResult = await redisOperation(() => redis.eval(RATE_SCRIPT, 1, key, RATE_TTL))
    const current = Number(rawResult)
    if (!Number.isInteger(current) || current < 1) throw unavailable()
    if (current > maximum) {
      throw new EmailVerificationError(
        'rate_limited',
        '请求过于频繁，请稍后重试'
      )
    }
  }

  return {
    async sendCode({ email, purpose, ip }) {
      const { normalized, identity } = validateIdentity(email)
      if (!isValidPurpose(purpose)) {
        throw new EmailVerificationError('invalid_purpose', '验证码用途不正确')
      }

      const redis = await redisClient()
      const cooldownKey = emailKey('cooldown', purpose, identity)
      const codeKey = emailKey('otp', purpose, identity)
      const attemptsKey = emailKey('attempts', purpose, identity)
      const acquired = await redisOperation(() =>
        redis.set(cooldownKey, '1', 'EX', COOLDOWN_TTL, 'NX')
      )
      if (acquired === null) {
        throw new EmailVerificationError('cooldown', '请 60 秒后再试')
      }
      if (acquired !== 'OK') throw unavailable()

      try {
        await enforceRate(redis, rateAddressKey(identity), MAX_EMAIL_SENDS)
        await enforceRate(redis, rateIpKey(ip), MAX_IP_SENDS)
      } catch (error) {
        await safeDelete(redis, cooldownKey)
        throw error
      }

      let code
      try {
        const generated = randomIntFn(0, 1000000)
        if (!Number.isInteger(generated) || generated < 0 || generated >= 1000000) {
          throw new Error('Invalid random number')
        }
        code = String(generated).padStart(6, '0')
      } catch {
        await safeDelete(redis, cooldownKey)
        throw new EmailVerificationError(
          'generation_failed',
          '验证码暂时无法生成，请稍后重试'
        )
      }

      try {
        const result = await redis.multi()
          .set(codeKey, otpDigest(purpose, identity, code), 'EX', CODE_TTL)
          .set(attemptsKey, '0', 'EX', CODE_TTL)
          .exec()
        const completed = Array.isArray(result) &&
          result.length === 2 &&
          result.every(entry => Array.isArray(entry) && entry[0] === null && entry[1] === 'OK')
        if (!completed) throw new Error('Incomplete Redis transaction')
      } catch {
        await safeDelete(redis, codeKey, attemptsKey, cooldownKey)
        throw unavailable()
      }

      try {
        await mailer.sendVerificationCode({ to: normalized, code, purpose })
      } catch {
        await safeDelete(redis, codeKey, attemptsKey, cooldownKey)
        throw new EmailVerificationError(
          'delivery_failed',
          '邮件暂时无法发送，请稍后重试'
        )
      }
      return { success: true }
    },

    async consumeCode({ email, purpose, code }) {
      const normalized = normalizeEmail(email)
      if (!isValidEmail(normalized) || !isValidPurpose(purpose) ||
        typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        return { ...INVALID_CODE_RESULT }
      }

      const identity = emailIdentity(normalized)
      const redis = await redisClient()
      const result = await redisOperation(() => redis.eval(
        CONSUME_SCRIPT,
        3,
        emailKey('otp', purpose, identity),
        emailKey('attempts', purpose, identity),
        emailKey('cooldown', purpose, identity),
        otpDigest(purpose, identity, code),
        CODE_TTL,
        MAX_ATTEMPTS
      ))
      return Number(result) === 1
        ? { success: true }
        : { ...INVALID_CODE_RESULT }
    },

    async getLoginLock(email) {
      const { identity } = validateIdentity(email)
      const redis = await redisClient()
      const result = await redisOperation(() => redis.multi()
        .get(loginKey(identity))
        .ttl(loginKey(identity))
        .exec())
      if (!Array.isArray(result) || result.length !== 2 ||
        result.some(entry => !Array.isArray(entry) || entry[0] !== null)) {
        throw unavailable()
      }

      const count = Number(result[0][1] ?? 0)
      const ttl = Number(result[1][1])
      if (!Number.isInteger(count) || count < 0 || !Number.isInteger(ttl)) throw unavailable()
      if (count === 0) return { count: 0, ttl: 0 }
      if (ttl < 0) throw unavailable()
      return { count, ttl }
    },

    async recordLoginFailure(email) {
      const { identity } = validateIdentity(email)
      const redis = await redisClient()
      const result = Number(await redisOperation(() => redis.eval(
        LOGIN_FAILURE_SCRIPT,
        1,
        loginKey(identity),
        LOGIN_LOCK_TTL
      )))
      if (!Number.isInteger(result) || result < 1) throw unavailable()
      return result
    },

    async clearSecurityState(email) {
      const { identity } = validateIdentity(email)
      const redis = await redisClient()
      await redisOperation(() => redis.del(
        loginKey(identity),
        emailKey('otp', 'reset', identity),
        emailKey('attempts', 'reset', identity),
        emailKey('cooldown', 'reset', identity)
      ))
    }
  }
}
