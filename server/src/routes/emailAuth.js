import { Router } from 'express'
import bcrypt from 'bcryptjs'
import config from '../config.js'
import db from '../db.js'
import { signToken } from '../middleware/auth.js'
import { getRedisClient } from '../redis.js'
import { createAuthAccountService } from '../services/authAccount.js'
import { createSmtpEmailService } from '../services/emailService.js'
import {
  createEmailVerificationService,
  EmailVerificationError,
  isValidEmail,
  maskEmail,
  normalizeEmail
} from '../services/emailVerificationService.js'
import { createLogger } from '../utils/logger.js'

const SALT_ROUNDS = 10
const MAX_LOGIN_ATTEMPTS = 5
const DUMMY_PASSWORD_HASH = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.'

const RESET_ACCEPTED = Object.freeze({
  success: true,
  message: '如果该邮箱已注册，验证码将发送到你的邮箱'
})
const INVALID_CODE = '验证码无效或已过期'
const INVALID_CREDENTIALS = '邮箱或密码错误'
const LOGIN_LOCKED = '登录尝试次数过多，请 15 分钟后重试'
const SERVICE_UNAVAILABLE = '服务暂时不可用，请稍后重试'

function diagnosticCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'UNKNOWN'
}

function hasValidCodeAndPassword(code, password) {
  return typeof code === 'string' && /^[0-9]{6}$/.test(code) &&
    typeof password === 'string' && password.length >= 6 &&
    Buffer.byteLength(password, 'utf8') <= 72
}

export function createEmailAuthRouter({
  accounts,
  verification,
  hashPassword,
  comparePassword,
  sign,
  now,
  logger
}) {
  const router = Router()

  const safe = (operation, handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      logger.error('Email authentication operation failed', {
        operation,
        errorCode: diagnosticCode(error)
      })
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: SERVICE_UNAVAILABLE })
      }
    }
  }

  router.post('/send-code', safe('send-code', async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const purpose = req.body?.purpose
    if (!isValidEmail(email) || (purpose !== 'register' && purpose !== 'reset')) {
      return res.status(400).json({
        success: false,
        error: '邮箱或验证码用途格式不正确'
      })
    }

    if (purpose === 'reset') {
      const ip = req.ip
      setImmediate(() => {
        void (async () => {
          try {
            const user = await accounts.findByEmail(email)
            if (user?.email_verified_at) {
              await verification.sendCode({ email, purpose, ip })
            }
          } catch (error) {
            logger.warn('Reset email verification delivery skipped', {
              operation: 'send-reset-code',
              email,
              reason: diagnosticCode(error)
            })
          }
        })().catch(() => {})
      })
      return res.status(202).json(RESET_ACCEPTED)
    }

    const existing = await accounts.findByEmail(email)
    if (existing) {
      return res.status(409).json({
        success: false,
        error: '该邮箱已注册，请直接登录'
      })
    }

    try {
      await verification.sendCode({ email, purpose, ip: req.ip })
      return res.json({ success: true, message: '验证码已发送' })
    } catch (error) {
      logger.warn('Registration email verification delivery failed', {
        operation: 'send-register-code',
        email,
        reason: diagnosticCode(error)
      })
      if (error instanceof EmailVerificationError) {
        const status = error.code === 'cooldown' || error.code === 'rate_limited'
          ? 429
          : ['delivery_failed', 'generation_failed', 'service_unavailable'].includes(error.code)
              ? 503
              : 400
        return res.status(status).json({ success: false, error: error.message })
      }

      return res.status(503).json({
        success: false,
        error: '邮件暂时无法发送，请稍后重试'
      })
    }
  }))

  router.post('/register', safe('register', async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const { code, password } = req.body || {}
    if (!isValidEmail(email) || !hasValidCodeAndPassword(code, password)) {
      return res.status(400).json({
        success: false,
        error: '邮箱、验证码或密码格式不正确'
      })
    }

    const existing = await accounts.findByEmail(email)
    if (existing) {
      return res.status(409).json({
        success: false,
        error: '该邮箱已注册，请直接登录'
      })
    }

    const consumed = await verification.consumeCode({
      email,
      purpose: 'register',
      code
    })
    if (!consumed.success) {
      return res.status(400).json({
        success: false,
        error: consumed.message || INVALID_CODE
      })
    }

    const passwordHash = await hashPassword(password, SALT_ROUNDS)
    let userId
    try {
      userId = await accounts.createEmailAccount({
        email,
        passwordHash,
        nickname: maskEmail(email),
        verifiedAt: now(),
        deviceId: req.deviceId
      })
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: '该邮箱已注册，请直接登录'
        })
      }
      throw error
    }

    const token = sign(userId)
    logger.info('Email registration succeeded', { userId, email })
    return res.json({ success: true, data: { token, userId } })
  }))

  // 简单邮箱注册（无需验证码）
  router.post('/register-simple', safe('register-simple', async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const password = req.body?.password
    if (!isValidEmail(email) || typeof password !== 'string' || password.length < 6 ||
      Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({
        success: false,
        error: '邮箱或密码格式不正确（密码至少6位）'
      })
    }

    const existing = await accounts.findByEmail(email)
    if (existing) {
      return res.status(409).json({
        success: false,
        error: '该邮箱已注册，请直接登录'
      })
    }

    const passwordHash = await hashPassword(password, SALT_ROUNDS)
    let userId
    try {
      userId = await accounts.createEmailAccount({
        email,
        passwordHash,
        nickname: email.split('@')[0],
        verifiedAt: now(),
        deviceId: req.deviceId
      })
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: '该邮箱已注册，请直接登录'
        })
      }
      throw error
    }

    const token = sign(userId)
    logger.info('Email simple registration succeeded', { userId, email })
    return res.json({ success: true, data: { token, userId } })
  }))

  router.post('/login', safe('login', async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const password = req.body?.password
    if (!isValidEmail(email) || typeof password !== 'string' || !password ||
      Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({
        success: false,
        error: '邮箱或密码格式不正确'
      })
    }

    const lock = await verification.getLoginLock(email)
    if (lock.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ success: false, error: LOGIN_LOCKED })
    }

    const user = await accounts.findByEmail(email)
    const verifiedAccount = Boolean(user?.password && user?.email_verified_at)
    const passwordMatches = await comparePassword(
      password,
      verifiedAccount ? user.password : DUMMY_PASSWORD_HASH
    )

    if (!verifiedAccount || !passwordMatches) {
      const failureCount = await verification.recordLoginFailure(email)
      if (failureCount >= MAX_LOGIN_ATTEMPTS) {
        return res.status(429).json({ success: false, error: LOGIN_LOCKED })
      }
      return res.status(401).json({ success: false, error: INVALID_CREDENTIALS })
    }

    await verification.clearSecurityState(email)
    await accounts.completeLogin(user.id, req.deviceId)
    const token = sign(user.id)
    logger.info('Email login succeeded', { userId: user.id, email })
    return res.json({ success: true, data: { token, userId: user.id } })
  }))

  router.post('/reset-password', safe('reset-password', async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const { code, password } = req.body || {}
    if (!isValidEmail(email) || !hasValidCodeAndPassword(code, password)) {
      return res.status(400).json({
        success: false,
        error: '邮箱、验证码或密码格式不正确'
      })
    }

    const consumed = await verification.consumeCode({
      email,
      purpose: 'reset',
      code
    })
    if (!consumed.success) {
      return res.status(400).json({ success: false, error: INVALID_CODE })
    }

    const user = await accounts.findByEmail(email)
    if (!user?.email_verified_at) {
      return res.status(400).json({ success: false, error: INVALID_CODE })
    }

    const passwordHash = await hashPassword(password, SALT_ROUNDS)
    await verification.clearSecurityState(email)
    const updated = await accounts.updatePassword(user.id, passwordHash)
    if (updated === 0) {
      const error = new Error('Password row was not updated')
      error.code = 'PASSWORD_NOT_UPDATED'
      throw error
    }
    logger.info('Email password reset succeeded', { userId: user.id, email })

    return res.json({
      success: true,
      message: '密码重置成功，请使用新密码登录'
    })
  }))

  return router
}

export function createDefaultEmailAuthRouter() {
  const mailer = createSmtpEmailService(config.email)
  const verification = createEmailVerificationService({
    getRedis: getRedisClient,
    secret: config.auth.emailOtpSecret,
    mailer
  })

  return createEmailAuthRouter({
    accounts: createAuthAccountService(db),
    verification,
    hashPassword: (password, rounds) => bcrypt.hash(password, rounds),
    comparePassword: (password, hash) => bcrypt.compare(password, hash),
    sign: signToken,
    now: () => db.fn.now(),
    logger: createLogger('EmailAuth')
  })
}
