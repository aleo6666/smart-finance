import crypto from 'crypto'
import config from '../config.js'
import { cacheDelete, cacheGet, cacheSet } from '../redis.js'

const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001])

export class WechatApiError extends Error {
  constructor(message, { code = null, status = 502 } = {}) {
    super(message)
    this.name = 'WechatApiError'
    this.code = code
    this.status = status
  }
}

function requireLoginConfig(wechatConfig) {
  if (!wechatConfig.miniAppId || !wechatConfig.miniSecret) {
    throw new WechatApiError('微信小程序登录配置缺失', { status: 503 })
  }
}

export function createWechatClient({
  wechatConfig = config.wechat,
  cache = { get: cacheGet, set: cacheSet, delete: cacheDelete },
  fetchFn = fetch
} = {}) {
  const tokenKey = `wechat:at:${wechatConfig.miniAppId}`

  async function readJson(url, options, failureMessage = '微信服务暂时不可用') {
    const result = await fetchFn(url, options)
    if (!result.ok) throw new WechatApiError(failureMessage)
    return result.json()
  }

  async function code2Session(code) {
    requireLoginConfig(wechatConfig)
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.searchParams.set('appid', wechatConfig.miniAppId)
    url.searchParams.set('secret', wechatConfig.miniSecret)
    url.searchParams.set('js_code', code)
    url.searchParams.set('grant_type', 'authorization_code')
    const json = await readJson(url)
    if (json.errcode) {
      const status = json.errcode === 40029 || json.errcode === 40163 ? 401 : 502
      throw new WechatApiError('微信登录凭证无效', { code: json.errcode, status })
    }
    return { openid: json.openid, unionid: json.unionid || null }
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    requireLoginConfig(wechatConfig)
    if (!forceRefresh) {
      const cached = await cache.get(tokenKey)
      if (cached) return cached
    }

    const url = new URL('https://api.weixin.qq.com/cgi-bin/token')
    url.searchParams.set('grant_type', 'client_credential')
    url.searchParams.set('appid', wechatConfig.miniAppId)
    url.searchParams.set('secret', wechatConfig.miniSecret)
    const json = await readJson(url, undefined, '获取微信访问令牌失败')
    if (json.errcode || !json.access_token) {
      throw new WechatApiError('获取微信访问令牌失败', { code: json.errcode })
    }
    const ttl = Math.max(60, Number(json.expires_in || 7200) - 300)
    await cache.set(tokenKey, json.access_token, ttl)
    return json.access_token
  }

  async function sendOnce(input, token) {
    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`
    return readJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: input.openid,
        template_id: input.templateId,
        page: input.page,
        data: input.data
      })
    }, '微信订阅消息发送失败')
  }

  async function sendSubscribeMessage(input) {
    let token = await getAccessToken()
    let json = await sendOnce(input, token)
    if (INVALID_TOKEN_CODES.has(Number(json.errcode))) {
      await cache.delete(tokenKey)
      token = await getAccessToken({ forceRefresh: true })
      json = await sendOnce(input, token)
    }
    if (json.errcode) {
      throw new WechatApiError('微信订阅消息发送失败', { code: json.errcode })
    }
    return json
  }

  async function mpAuthorizeUrl(redirectUri) {
    const appId = wechatConfig.mpAppId || wechatConfig.miniAppId
    if (!appId) throw new WechatApiError('微信公众号配置缺失', { status: 503 })
    const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize')
    url.searchParams.set('appid', appId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'snsapi_userinfo')
    url.searchParams.set('state', 'login')
    return `${url.toString()}#wechat_redirect`
  }

  async function mpCode2Session(code) {
    const appId = wechatConfig.mpAppId || wechatConfig.miniAppId
    const secret = wechatConfig.mpSecret || wechatConfig.miniSecret
    if (!appId || !secret) throw new WechatApiError('微信公众号配置缺失', { status: 503 })
    const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
    tokenUrl.searchParams.set('appid', appId)
    tokenUrl.searchParams.set('secret', secret)
    tokenUrl.searchParams.set('code', code)
    tokenUrl.searchParams.set('grant_type', 'authorization_code')
    const tokenJson = await readJson(tokenUrl, undefined, '获取微信公众号访问令牌失败')
    if (tokenJson.errcode || !tokenJson.access_token) {
      throw new WechatApiError('微信公众号授权失败', { code: tokenJson.errcode })
    }
    const infoUrl = `https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(tokenJson.access_token)}&openid=${encodeURIComponent(tokenJson.openid)}&lang=zh_CN`
    const infoJson = await readJson(infoUrl, undefined, '获取微信公众号用户信息失败')
    if (infoJson.errcode) throw new WechatApiError('获取微信公众号用户信息失败', { code: infoJson.errcode })
    return { openid: infoJson.openid, unionid: infoJson.unionid || null, nickname: infoJson.nickname, avatar: infoJson.headimgurl }
  }

  return { code2Session, getAccessToken, sendSubscribeMessage, mpAuthorizeUrl, mpCode2Session }
}

// Default client instance for backward compatibility
let _defaultClient = null
function getDefaultClient() {
  if (!_defaultClient) _defaultClient = createWechatClient()
  return _defaultClient
}

export const code2Session = (...args) => getDefaultClient().code2Session(...args)
export const mpAuthorizeUrl = (...args) => getDefaultClient().mpAuthorizeUrl(...args)
export const mpCode2Session = (...args) => getDefaultClient().mpCode2Session(...args)

export async function getPhoneNumber(code, encryptedData, iv, miniConfig) {
  // Step 1: Exchange code for session_key
  const sessionUrl = new URL('https://api.weixin.qq.com/sns/jscode2session')
  sessionUrl.searchParams.set('appid', miniConfig.miniAppId)
  sessionUrl.searchParams.set('secret', miniConfig.miniSecret)
  sessionUrl.searchParams.set('js_code', code)
  sessionUrl.searchParams.set('grant_type', 'authorization_code')

  const sessionRes = await fetch(sessionUrl.toString())
  const session = await sessionRes.json()

  if (session.errcode) {
    throw new Error(`微信 code2session 失败: ${session.errmsg} (errcode=${session.errcode})`)
  }

  const sessionKey = session.session_key

  // Step 2: Decrypt encryptedData with session_key
  const sessionKeyBuffer = Buffer.from(sessionKey, 'base64')
  const encryptedBuffer = Buffer.from(encryptedData, 'base64')
  const ivBuffer = Buffer.from(iv, 'base64')

  const decipher = crypto.createDecipheriv('aes-128-cbc', sessionKeyBuffer, ivBuffer)
  decipher.setAutoPadding(true)

  let decoded = decipher.update(encryptedBuffer, 'binary', 'utf8')
  decoded += decipher.final('utf8')

  const data = JSON.parse(decoded)

  if (!data.phoneNumber) {
    throw new Error('解密结果中无手机号')
  }

  return {
    phoneNumber: data.phoneNumber,
    countryCode: data.countryCode || '86',
    openid: session.openid,
    unionid: session.unionid || null
  }
}
