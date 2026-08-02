/**
 * SMS 短信验证码服务
 *
 * 开发/测试模式: 验证码打印到控制台（不实际发送短信）
 * 生产环境: 接入阿里云短信服务 / 腾讯云短信
 *
 * Redis 存储:
 *   sms:code:{phone} → 验证码 (5min TTL)
 *   sms:cooldown:{phone} → 发送冷却 (60s TTL)
 */

import { getRedisClient } from '../redis.js'

const CODE_TTL = 300       // 验证码有效期 5 分钟
const COOLDOWN_TTL = 60    // 发送间隔 60 秒
const MAX_ATTEMPTS = 3     // 最大验证尝试次数

/**
 * 生成 6 位随机数字验证码
 */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/**
 * 发送短信验证码
 * @param {string} phone - 手机号
 * @returns {{ success: boolean, message: string }}
 */
export async function sendVerificationCode(phone) {
  // 手机号格式校验
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return { success: false, message: '手机号格式不正确' }
  }

  const redis = getRedisClient()
  if (redis.status === 'wait') await redis.connect()

  // 冷却检查
  const cooldownKey = `sms:cooldown:${phone}`
  const cooldown = await redis.get(cooldownKey)
  if (cooldown) {
    const remaining = Math.ceil((Number(cooldown) - Date.now()) / 1000)
    return { success: false, message: `请 ${remaining} 秒后再试` }
  }

  // 生成验证码
  const code = generateCode()
  const codeKey = `sms:code:${phone}`

  // 存储到 Redis
  await redis.set(codeKey, code, 'EX', CODE_TTL)
  await redis.set(cooldownKey, String(Date.now() + COOLDOWN_TTL * 1000), 'EX', COOLDOWN_TTL)
  await redis.set(`sms:attempts:${phone}`, '0', 'EX', CODE_TTL)

  // 开发模式：打印到控制台
  console.log(`\n📱 [SMS] 验证码已发送到 ${phone}: ${code}\n`)

  return { success: true, message: '验证码已发送' }
}

/**
 * 验证短信验证码
 * @param {string} phone - 手机号
 * @param {string} code - 用户输入的验证码
 * @returns {{ success: boolean, message: string }}
 */
export async function verifyCode(phone, code) {
  if (!phone || !code) {
    return { success: false, message: '手机号和验证码不能为空' }
  }

  const redis = getRedisClient()
  if (redis.status === 'wait') await redis.connect()

  // 检查尝试次数
  const attemptsKey = `sms:attempts:${phone}`
  const attempts = Number(await redis.get(attemptsKey) || 0)
  if (attempts >= MAX_ATTEMPTS) {
    await redis.del(`sms:code:${phone}`)
    return { success: false, message: '验证码已失效，请重新发送' }
  }

  // 递增尝试次数
  await redis.set(attemptsKey, String(attempts + 1), 'EX', CODE_TTL)

  // 验证
  const storedCode = await redis.get(`sms:code:${phone}`)
  if (!storedCode) {
    return { success: false, message: '验证码已过期，请重新发送' }
  }

  if (storedCode !== code) {
    return { success: false, message: `验证码错误（剩余 ${MAX_ATTEMPTS - attempts - 1} 次）` }
  }

  // 验证成功，删除验证码
  await redis.del(`sms:code:${phone}`)
  await redis.del(attemptsKey)
  await redis.del(`sms:cooldown:${phone}`)

  return { success: true, message: '验证通过' }
}

export default { sendVerificationCode, verifyCode }
