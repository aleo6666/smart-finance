import { Router } from 'express'
import bcrypt from 'bcryptjs'
import config from '../config.js'
import db from '../db.js'
import { code2Session, mpAuthorizeUrl, mpCode2Session } from '../services/wechat.js'
import { signToken, authMiddleware } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('Auth')

const router = Router()
const SALT_ROUNDS = 10

async function createDefaultLedger(userId) {
  const existing = await db('ledgers').where({ user_id: userId }).first()
  if (!existing) {
    await db('ledgers').insert({ user_id: userId, name: '我的账本', base_currency: 'CNY' })
  }
}

/** 将同一设备上未登录时创建的记录关联到新注册/登录的用户 */
async function migrateGuestRecords(userId, deviceId) {
  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') return
  const updated = await db('records')
    .where({ device_id: deviceId, user_id: null })
    .update({ user_id: userId })
  if (updated > 0) {
    console.log(`[Auth] migrated ${updated} guest records → user ${userId}`)
  }
}

router.post('/register', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ success: false, error: '缺少用户名或密码' })
  if (password.length < 6) return res.status(400).json({ success: false, error: '密码至少6位' })

  const cleanUsername = username.trim()
  const exists = await db('users').where({ username: cleanUsername }).first()
  if (exists) {
    logger.warn('注册失败：用户名已存在', { username: cleanUsername })
    return res.status(409).json({ success: false, error: '用户名已存在' })
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS)
  const [userId] = await db('users').insert({ username: cleanUsername, password: hash, nickname: cleanUsername })
  await createDefaultLedger(userId)
  await migrateGuestRecords(userId, req.deviceId)

  logger.info('注册成功', { userId, username: cleanUsername })
  res.json({ success: true, data: { token: signToken(userId), userId } })
})

router.post('/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ success: false, error: '缺少用户名或密码' })

  const user = await db('users').where({ username: username.trim() }).first()
  if (!user?.password) {
    logger.warn('登录失败：用户名不存在', { username: username.trim() })
    return res.status(401).json({ success: false, error: '用户名或密码错误' })
  }

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) {
    logger.warn('登录失败：密码错误', { userId: user.id, username: username.trim() })
    return res.status(401).json({ success: false, error: '用户名或密码错误' })
  }

  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
  await migrateGuestRecords(user.id, req.deviceId)
  logger.info('登录成功', { userId: user.id, username: username.trim() })
  res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
})

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

    // Find user by phone number
    const maskedPhone = phoneNumber.slice(0, 3) + '****' + phoneNumber.slice(-4)
    let user = await db('users').where({ phone: phoneNumber }).first()

    if (!user) {
      // New user: create
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
      // Existing user: update openid
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

router.post('/bind-phone', authMiddleware, async (req, res) => {
  await db('users').where({ id: req.userId }).update({ phone: req.body.phone || null })
  res.json({ success: true })
})

router.get('/me', authMiddleware, async (req, res) => {
  const user = await db('users')
    .select('id', 'username', 'nickname', 'phone', 'avatar')
    .where({ id: req.userId })
    .first()
  const ledgers = await db('ledgers').where({ user_id: req.userId }).orderBy('created_at')
  res.json({ success: true, data: { user, ledgers } })
})

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
