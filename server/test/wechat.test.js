import test from 'node:test'
import assert from 'node:assert/strict'
import { createWechatClient, WechatApiError } from '../src/services/wechat.js'

function response(json, ok = true) {
  return { ok, json: async () => json }
}

test('code2Session exchanges code without exposing session key', async () => {
  const calls = []
  const client = createWechatClient({
    wechatConfig: { miniAppId: 'wx-app', miniSecret: 'top-secret' },
    fetchFn: async url => {
      calls.push(String(url))
      return response({ openid: 'openid-7', unionid: 'union-7', session_key: 'private-key' })
    }
  })

  assert.deepEqual(await client.code2Session('login-code'), { openid: 'openid-7', unionid: 'union-7' })
  assert.match(calls[0], /jscode2session/)
  assert.match(calls[0], /js_code=login-code/)
})

test('getAccessToken stores the token with a safe ttl', async () => {
  const cacheCalls = []
  const client = createWechatClient({
    wechatConfig: { miniAppId: 'wx-app', miniSecret: 'secret' },
    cache: {
      get: async () => null,
      set: async (key, value, ttl) => cacheCalls.push({ key, value, ttl }),
      delete: async () => {}
    },
    fetchFn: async () => response({ access_token: 'token-1', expires_in: 7200 })
  })

  assert.equal(await client.getAccessToken(), 'token-1')
  assert.deepEqual(cacheCalls[0], { key: 'wechat:at:wx-app', value: 'token-1', ttl: 6900 })
})

test('sendSubscribeMessage refreshes an invalid token once', async () => {
  const tokens = []
  let tokenCalls = 0
  let deleteCalls = 0
  const client = createWechatClient({
    wechatConfig: { miniAppId: 'wx-app', miniSecret: 'secret' },
    cache: {
      get: async () => null,
      set: async () => {},
      delete: async key => {
        assert.equal(key, 'wechat:at:wx-app')
        deleteCalls += 1
      }
    },
    fetchFn: async url => {
      if (String(url).includes('/cgi-bin/token')) {
        tokenCalls += 1
        return response({ access_token: `token-${tokenCalls}`, expires_in: 7200 })
      }
      tokens.push(new URL(String(url)).searchParams.get('access_token'))
      return response(tokens.length === 1
        ? { errcode: 40001, errmsg: 'invalid credential' }
        : { errcode: 0, errmsg: 'ok' })
    }
  })

  const result = await client.sendSubscribeMessage({
    openid: 'openid-7',
    templateId: 'tpl',
    page: 'pages/reminders/confirm/index?id=9',
    data: { thing1: { value: '餐饮月度预算' } }
  })

  assert.equal(result.errcode, 0)
  assert.deepEqual(tokens, ['token-1', 'token-2'])
  assert.equal(deleteCalls, 1)
})

test('missing credentials produce a typed safe error', async () => {
  const client = createWechatClient({
    wechatConfig: { miniAppId: '', miniSecret: '' }
  })

  await assert.rejects(client.code2Session('code'), error => {
    assert.ok(error instanceof WechatApiError)
    assert.equal(error.status, 503)
    assert.equal(error.message, '微信小程序登录配置缺失')
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})
