import { Router } from 'express'
import bcrypt from 'bcryptjs'
import db from '../db.js'
import { code2Session, mpAuthorizeUrl, mpCode2Session } from '../services/wechat.js'
import { signToken, authMiddleware } from '../middleware/auth.js'

const router = Router()
const SALT_ROUNDS = 10

async function createDefaultLedger(userId) {
  const existing = await db('ledgers').where({ user_id: userId }).first()
  if (!existing) {
    await db('ledgers').insert({ user_id: userId, name: '我的账本', base_currency: 'CNY' })
  }
}

router.post('/register', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ success: false, error: '缺少用户名或密码' })
  if (password.length < 6) return res.status(400).json({ success: false, error: '密码至少6位' })

  const cleanUsername = username.trim()
  const exists = await db('users').where({ username: cleanUsername }).first()
  if (exists) return res.status(409).json({ success: false, error: '用户名已存在' })

  const hash = await bcrypt.hash(password, SALT_ROUNDS)
  const [userId] = await db('users').insert({ username: cleanUsername, password: hash, nickname: cleanUsername })
  await createDefaultLedger(userId)

  res.json({ success: true, data: { token: signToken(userId), userId } })
})

router.post('/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ success: false, error: '缺少用户名或密码' })

  const user = await db('users').where({ username: username.trim() }).first()
  if (!user?.password) return res.status(401).json({ success: false, error: '用户名或密码错误' })

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) return res.status(401).json({ success: false, error: '用户名或密码错误' })

  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
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
    }
    await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
    res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

router.post('/mock-login', async (_req, res) => {
  const mockOpenid = 'dev-mock-openid'
  let user = await db('users').where({ mini_openid: mockOpenid }).first()
  if (!user) {
    const [userId] = await db('users').insert({ mini_openid: mockOpenid, nickname: '开发测试用户' })
    user = await db('users').where({ id: userId }).first()
    await createDefaultLedger(userId)
  }
  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() })
  res.json({ success: true, data: { token: signToken(user.id), userId: user.id } })
})

router.post('/bind-phone', authMiddleware, async (req, res) => {
  await db('users').where({ id: req.userId }).update({ phone: req.body.phone || null })
  res.json({ success: true })
})

router.get('/me', authMiddleware, async (req, res) => {
  const user = await db('users')
    .select('id', 'username', 'nickname', 'phone', 'avatar', 'mini_openid')
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
    } else {
      await db('users').where({ id: user.id }).update({ mp_openid: openid, unionid: unionid || user.unionid })
    }
    res.redirect(`/?token=${signToken(user.id)}`)
  } catch (e) {
    res.status(500).send(e.message)
  }
})

export default router
