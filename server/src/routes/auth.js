import { Router } from 'express'
import bcrypt from 'bcryptjs'
import config from '../config.js'
import db from '../db.js'
import { code2Session, mpAuthorizeUrl, mpCode2Session } from '../services/wechat.js'
import { signToken, authMiddleware } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'
import { sendVerificationCode, verifyCode } from '../services/sms.js'

const logger = createLogger('Auth')
const router = Router()
const SALT_ROUNDS = 10
const MAX_LOGIN_ATTEMPTS = 5

async function createDefaultLedger(userId) {
  const existing = await db('ledgers').where({ user_id: userId }).first()
  if (!existing) {
    await db('ledgers').insert({ user_id: userId, name: '我的账本', base_currency: 'CNY' })
  }
}

async function migrateGuestRecords(userId, deviceId) {
  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') return
  const updated = await db('records')
    .where({ device_id: deviceId, user_id: null })
    .update({ user_id: userId })
  if (updated > 0) {
    console.log(`[Auth] migrated ${updated} guest records → user ${userId}`)
  }
}

// ============================================================
// 发送短信验证码
// ============================================================
router.post('/send-code', async (req, res) => {
  try {
    const { phone } = req.body
    const result = await sendVerificationCode(phone)
    if (!result.success) {
      return res.status(429).json({ success: false, error: result.message })
    }
    res.json({ success: true, message: result.message })
  } catch (error) {
    logger.warn('发送验证码失败', { error: error.message })
    res.status(500).json({ success: false, error: '发送失败，请稍后重试' })
  }
})

// ============================================================
// 手机号注册
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const { phone, code, password } = req.body

    // 参数校验
    if (!phone || !code || !password) {
      return res.status(400).json({ success: false, error: '缺少手机号、验证码或密码' })
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: '手机号格式不正确' })
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: '密码至少6位' })
    }

    // 验证短信验证码
    const verifyResult = await verifyCode(phone, code)
    if (!verifyResult.success) {
      return res.status(400).json({ success: false, error: verifyResult.message })
    }

    // 检查手机号是否已注册
    const existing = await db('users').where({ phone }).first()
    if (existing) {
      logger.warn('注册失败：手机号已注册', { phone: phone.slice(0, 3) + '****' + phone.slice(-4) })
      return res.status(409).json({ success: false, error: '该手机号已注册，请直接登录' })
    }

    // 创建用户
    const hash = await bcrypt.hash(password, SALT_ROUNDS)
    const maskedPhone = phone.slice(0, 3) + '****' + phone.slice(-4)
    const [userId] = await db('users').insert({
      phone,
      password: hash,
      username: phone,
      nickname: maskedPhone
    })

    await createDefaultLedger(userId)
    await migrateGuestRecords(userId, req.deviceId)

    const token = signToken(userId)
    logger.info('注册成功', { userId, phone: maskedPhone })
    res.json({ success: true, data: { token, userId } })
  } catch (error) {
    logger.error('注册失败', { error: error.message })
    res.status(500).json({ success: false, error: '注册失败，请稍后重试' })
  }
})

// ============================================================
// 手机号登录（含失败次数限制）
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body

    if (!phone || !password) {
      return res.status(400).json({ success: false, error: '请输入手机号和密码' })
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: '手机号格式不正确' })
    }

    // 登录冷却检查（Redis）
    const redis = (await import('../redis.js')).getRedisClient()
    if (redis.status === 'wait') await redis.connect()

    const lockKey = `login:lock:${phone}`
    const lockCount = Number(await redis.get(lockKey) || 0)
    if (lockCount >= MAX_LOGIN_ATTEMPTS) {
      const ttl = await redis.ttl(lockKey)
      return res.status(429).json({
        success: false,
        error: `登录尝试次数过多，请 ${Math.ceil(ttl / 60)} 分钟后重试`
      })
    }

    // 查找用户
    const user = await db('users').where({ phone }).first()
    if (!user?.password) {
      await redis.incr(lockKey)
      await redis.expire(lockKey, 900) // 15 分钟锁定
      logger.warn('登录失败：手机号不存在', { phone: phone.slice(0, 3) + '****' + phone.slice(-4) })
      return res.status(401).json({ success: false, error: '手机号或密码错误' })
    }

    // 验证密码
    const ok = await bcrypt.compare(password, user.password)
    if (!ok) {
      await redis.incr(lockKey)
      await redis.expire(lockKey, 900)
      const remaining = MAX_LOGIN_ATTEMPTS - lockCount - 1
      logger.warn('登录失败：密码错误', { userId: user.id, phone: phone.slice(0, 3) + '****' + phone.slice(-4) })
      return res.status(401).json({
        success: false,
        error: remaining > 0 ? `密码错误（剩余 ${remaining} 次尝试）` : '登录尝试次数过多，请 15 分钟后重试'
      })
    }

    // 登录成功 — 清除锁定
    await redis.del(lockKey)
    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
    await migrateGuestRecords(user.id, req.deviceId)

    const token = signToken(user.id)
    logger.info('登录成功', { userId: user.id, phone: phone.slice(0, 3) + '****' + phone.slice(-4) })
    res.json({ success: true, data: { token, userId: user.id } })
  } catch (error) {
    logger.error('登录失败', { error: error.message })
    res.status(500).json({ success: false, error: '登录失败，请稍后重试' })
  }
})

// ============================================================
// 忘记密码 — 验证手机号 + 验证码后重置
// ============================================================
router.post('/reset-password', async (req, res) => {
  try {
    const { phone, code, password } = req.body

    if (!phone || !code || !password) {
      return res.status(400).json({ success: false, error: '缺少手机号、验证码或新密码' })
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: '新密码至少6位' })
    }

    // 验证短信验证码
    const verifyResult = await verifyCode(phone, code)
    if (!verifyResult.success) {
      return res.status(400).json({ success: false, error: verifyResult.message })
    }

    // 查找用户
    const user = await db('users').where({ phone }).first()
    if (!user) {
      return res.status(404).json({ success: false, error: '该手机号未注册' })
    }

    // 更新密码
    const hash = await bcrypt.hash(password, SALT_ROUNDS)
    await db('users').where({ id: user.id }).update({ password: hash })

    const maskedPhone = phone.slice(0, 3) + '****' + phone.slice(-4)
    logger.info('密码重置成功', { userId: user.id, phone: maskedPhone })
    res.json({ success: true, message: '密码重置成功，请使用新密码登录' })
  } catch (error) {
    logger.error('密码重置失败', { error: error.message })
    res.status(500).json({ success: false, error: '重置失败，请稍后重试' })
  }
})

// ============================================================
// 微信小程序登录
// ============================================================
router.post('/wechat-mini', async (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ success: false, error: '缺少 code' })
  try {
    const { openid, unionid } = await code2Session(code)
    let user = await db('users').where({ mini_openid: openid }).first()
    if (!user) {
      const [userId] = await db('users').insert({ mini_openid: openid, unionid: unionid || null })
      user = await db('users').where({ id: userId }).first()
      await createDefaultLedger(userId)
      await migrateGuestRecords(userId, req.deviceId)
    }
    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
    await migrateGuestRecords(user.id, req.deviceId)
    res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
  } catch (e) {
    res.status(500).json({ success: false, error: '微信登录服务暂不可用，请稍后重试' })
  }
})

// ============================================================
// 微信手机号登录
// ============================================================
router.post('/wechat-phone', async (req, res) => {
  const { code, encryptedData, iv } = req.body
  if (!code || !encryptedData || !iv) {
    return res.status(400).json({ success: false, error: '缺少必填参数' })
  }
  try {
    const { getPhoneNumber } = await import('../services/wechat.js')
    const { phoneNumber, openid, unionid } = await getPhoneNumber(code, encryptedData, iv, {
      miniAppId: config.wechat?.miniAppId || process.env.WECHAT_MINI_APPID || '',
      miniSecret: config.wechat?.miniSecret || process.env.WECHAT_MINI_SECRET || ''
    })

    const maskedPhone = phoneNumber.slice(0, 3) + '****' + phoneNumber.slice(-4)
    let user = await db('users').where({ phone: phoneNumber }).first()

    if (!user) {
      const [userId] = await db('users').insert({
        mini_openid: openid,
        unionid: unionid || null,
        phone: phoneNumber,
        nickname: maskedPhone,
        username: maskedPhone
      })
      user = await db('users').where({ id: userId }).first()
      await createDefaultLedger(userId)
      await migrateGuestRecords(userId, req.deviceId)
    } else {
      await db('users').where({ id: user.id }).update({
        mini_openid: openid,
        unionid: unionid || user.unionid
      })
    }

    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
    await migrateGuestRecords(user.id, req.deviceId)

    logger.info('手机号登录成功', { userId: user.id, phone: maskedPhone })
    res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
  } catch (e) {
    logger.warn('手机号登录失败', { error: e.message })
    res.status(500).json({ success: false, error: '登录失败，请稍后重试' })
  }
})

// ============================================================
// 开发环境模拟登录
// ============================================================
if (process.env.NODE_ENV !== 'production') {
  router.post('/mock-login', async (req, res) => {
    const mockOpenid = 'dev-mock-openid'
    let user = await db('users').where({ mini_openid: mockOpenid }).first()
    if (!user) {
      const [userId] = await db('users').insert({ mini_openid: mockOpenid, nickname: '开发测试用户' })
      user = await db('users').where({ id: userId }).first()
      await createDefaultLedger(userId)
      await migrateGuestRecords(userId, req.deviceId)
    }
    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
    await migrateGuestRecords(user.id, req.deviceId)
    res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
  })
}

// ============================================================
// 绑定手机号
// ============================================================
router.post('/bind-phone', authMiddleware, async (req, res) => {
  await db('users').where({ id: req.userId }).update({ phone: req.body.phone || null })
  res.json({ success: true })
})

// ============================================================
// 获取当前用户信息
// ============================================================
router.get('/me', authMiddleware, async (req, res) => {
  const user = await db('users')
    .select('id', 'username', 'nickname', 'phone', 'avatar')
    .where({ id: req.userId })
    .first()
  const ledgers = await db('ledgers').where({ user_id: req.userId }).orderBy('created_at')
  res.json({ success: true, data: { user, ledgers } })
})

// ============================================================
// 微信公众号授权
// ============================================================
router.get('/wechat-mp', async (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/wechat-mp`
  if (!req.query.code) return res.redirect(mpAuthorizeUrl(redirectUri))
  try {
    const { openid, unionid, nickname, avatar } = await mpCode2Session(req.query.code)
    let user = await db('users')
      .where('mp_openid', openid)
      .orWhere(builder => builder.whereNotNull('unionid').where('unionid', unionid || ''))
      .first()

    if (!user) {
      const [userId] = await db('users').insert({ mp_openid: openid, unionid: unionid || null, nickname: nickname || null, avatar: avatar || null })
      user = await db('users').where({ id: userId }).first()
      await createDefaultLedger(userId)
      await migrateGuestRecords(userId, req.deviceId)
    } else {
      await db('users').where({ id: user.id }).update({ mp_openid: openid, unionid: unionid || user.unionid })
    }
    await migrateGuestRecords(user.id, req.deviceId)
    res.redirect(`/?token=${signToken(user.id)}`)
  } catch (e) {
    res.status(500).send('服务暂不可用，请稍后重试')
  }
})

export default router
