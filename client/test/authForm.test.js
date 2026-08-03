import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  isValidAuthIdentity,
  isValidAuthPassword,
  normalizeEmail,
  purposeForMode,
  requestForAuthMode
} from '../src/utils/authForm.js'
import { api } from '../src/utils/api.js'

const loginPageSource = readFileSync(
  new URL('../src/components/LoginPage.vue', import.meta.url),
  'utf8'
)

test('login page defaults to email and renders an accessible channel-aware identity input', () => {
  assert.match(loginPageSource, /const channel = ref\(['"]email['"]\)/)
  assert.match(loginPageSource, /class="channel-bar"[^>]*aria-label="登录方式"/)
  assert.match(loginPageSource, /type="button"[^>]*:class="\{ active: channel === 'email' \}"[^>]*:aria-pressed="channel === 'email'"/s)
  assert.match(loginPageSource, /type="button"[^>]*:class="\{ active: channel === 'phone' \}"[^>]*:aria-pressed="channel === 'phone'"/s)
  assert.match(loginPageSource, /v-model="identity"/)
  assert.match(loginPageSource, /:type="channel === 'email' \? 'email' : 'tel'"/)
  assert.match(loginPageSource, /:maxlength="channel === 'email' \? 254 : 11"/)
  assert.match(loginPageSource, /:autocomplete="channel === 'email' \? 'email' : 'tel'"/)
})

test('login page labels every authentication input for assistive technology', () => {
  for (const id of ['auth-identity', 'auth-code', 'auth-password', 'auth-confirm-password']) {
    assert.match(loginPageSource, new RegExp(`<label for="${id}">`), id)
    assert.match(loginPageSource, new RegExp(`<input\\s+[\\s\\S]*?id="${id}"`), id)
  }
})

test('login page uses shared auth helpers for all channel and mode requests', () => {
  for (const helper of [
    'isValidAuthIdentity',
    'isValidAuthPassword',
    'normalizeEmail',
    'purposeForMode',
    'requestForAuthMode'
  ]) {
    assert.match(loginPageSource, new RegExp(`\\b${helper}\\b`), helper)
  }

  assert.match(loginPageSource, /isValidAuthIdentity\(channel\.value, identity\.value\)/)
  assert.match(loginPageSource, /api\.emailSendCode\(normalizeEmail\(identity\.value\), purposeForMode\(mode\.value\)\)/)
  assert.match(loginPageSource, /requestForAuthMode\(api,\s*\{[\s\S]*?channel: channel\.value,[\s\S]*?mode: mode\.value/)
})

test('login page separates code delivery from submission and disables mutable controls', () => {
  assert.match(loginPageSource, /const sendingCode = ref\(false\)/)
  assert.match(loginPageSource, /if \(loading\.value \|\| sendingCode\.value\) return/g)
  assert.match(loginPageSource, /sendingCode\.value = true[\s\S]*?finally\s*\{\s*if \(!disposed\) sendingCode\.value = false/)
  assert.match(loginPageSource, /:disabled="loading \|\| sendingCode"/)
  assert.match(loginPageSource, /:disabled="[^"]*sendingCode[^"]*!identityValid[^"]*"/)
})

test('login page enforces strict verification codes and clears sensitive fields on switches', () => {
  assert.match(loginPageSource, /inputmode="numeric"/)
  assert.match(loginPageSource, /maxlength="6"/)
  assert.match(loginPageSource, /autocomplete="one-time-code"/)
  assert.match(loginPageSource, /!\/\^\[0-9\]\{6\}\$\/\.test\(code\.value\)/)
  assert.match(loginPageSource, /function clearSensitiveFields\(\)\s*\{[\s\S]*?code\.value = ''[\s\S]*?password\.value = ''[\s\S]*?confirmPassword\.value = ''/)
  assert.match(loginPageSource, /function switchMode\([^)]+\)\s*\{[\s\S]*?clearSensitiveFields\(\)[\s\S]*?stopCountdown\(\)/)
  assert.match(loginPageSource, /function switchChannel\([^)]+\)\s*\{[\s\S]*?identity\.value = ''[\s\S]*?clearSensitiveFields\(\)[\s\S]*?stopCountdown\(\)/)
})

test('login page owns and disposes its verification countdown', () => {
  assert.match(loginPageSource, /const verificationCountdown = ref\(0\)/)
  assert.match(loginPageSource, /function stopCountdown\(\)\s*\{[\s\S]*?clearInterval\(countdownTimer\)[\s\S]*?countdownTimer = null[\s\S]*?verificationCountdown\.value = 0/)
  assert.match(loginPageSource, /stopCountdown\(\)[\s\S]*?verificationCountdown\.value = 60[\s\S]*?setInterval/)
  assert.match(loginPageSource, /let disposed = false/)
  assert.match(loginPageSource, /onUnmounted\(\(\) => \{\s*disposed = true\s*stopCountdown\(\)\s*\}\)/)
})

test('async authentication paths stop updating component state after unmount', () => {
  const sendCodeBlock = loginPageSource.match(/async function sendCode\(\)[\s\S]*?(?=\nasync function doSubmit)/)?.[0] ?? ''
  const submitBlock = loginPageSource.match(/async function doSubmit\(\)[\s\S]*?(?=\nasync function doMockLogin)/)?.[0] ?? ''
  const mockBlock = loginPageSource.match(/async function doMockLogin\(\)[\s\S]*?(?=\nfunction showWechatTip)/)?.[0] ?? ''
  const mountedBlock = loginPageSource.match(/onMounted\(async \(\) => \{[\s\S]*?(?=\n\}\)\n<\/script>)/)?.[0] ?? ''

  assert.match(sendCodeBlock, /: await api\.sendCode\(identity\.value\)\s*if \(disposed\) return\s*if \(res\.success\)/)
  assert.match(sendCodeBlock, /catch \(e\) \{\s*if \(!disposed\) error\.value =/)
  assert.match(sendCodeBlock, /finally \{\s*if \(!disposed\) sendingCode\.value = false/)

  assert.match(submitBlock, /password: password\.value\s*\}\)\s*if \(disposed\) return\s*if \(res\.success\)/)
  assert.match(submitBlock, /await store\.loadUser\(\)\s*if \(disposed\) return\s*router\.push\('\/'\)/)
  assert.match(submitBlock, /catch \(e\) \{\s*if \(!disposed\) error\.value =/)
  assert.match(submitBlock, /finally \{\s*if \(!disposed\) loading\.value = false/)

  assert.match(mockBlock, /await api\.mockLogin\(\)\s*if \(disposed\) return\s*if \(res\.success\)/)
  assert.match(mockBlock, /await store\.loadUser\(\)\s*if \(disposed\) return\s*router\.push\('\/'\)/)
  assert.match(mockBlock, /catch \(e\) \{\s*if \(!disposed\) error\.value =/)
  assert.match(mockBlock, /finally \{\s*if \(!disposed\) loading\.value = false/)

  assert.match(mountedBlock, /await store\.loadUser\(\)\s*if \(disposed\) return\s*router\.replace/)
  assert.match(mountedBlock, /catch \(e\) \{\s*if \(!disposed\) \{[\s\S]*?error\.value =/)
  assert.match(mountedBlock, /finally \{\s*if \(!disposed\) loading\.value = false/)
})

test('reset success survives the mode switch and credentials are never persisted or put in URLs', () => {
  assert.match(loginPageSource, /loading\.value = false\s*switchMode\('login'\)\s*success\.value = '密码重置成功，请使用新密码登录'/)
  assert.doesNotMatch(loginPageSource, /const phone = ref\(/)
  assert.doesNotMatch(loginPageSource, /sms-row|btn-sms|smsCountdown/)
  assert.doesNotMatch(loginPageSource, /localStorage|sessionStorage|URLSearchParams/)
  assert.doesNotMatch(loginPageSource, /(?:router\.(?:push|replace)|query\s*:)[^\n]*(?:password|code)/i)
})

test('normalizeEmail trims and lowercases strings safely', () => {
  assert.equal(normalizeEmail(' User.Name+Tag@Example.COM '), 'user.name+tag@example.com')
  assert.equal(normalizeEmail(null), '')
  assert.equal(normalizeEmail(123), '')
})

test('isValidAuthIdentity accepts the supported email grammar', () => {
  const longestValidDomain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`

  assert.equal(isValidAuthIdentity('email', 'user@example.com'), true)
  assert.equal(isValidAuthIdentity('email', "o'hara+tag@sub.example-domain.co.uk"), true)
  assert.equal(isValidAuthIdentity('email', `${'a'.repeat(64)}@example.com`), true)
  assert.equal(isValidAuthIdentity('email', `${'a'.repeat(64)}@${longestValidDomain}`), true)
  assert.equal(isValidAuthIdentity('email', ' User@Example.COM '), true)
})

test('isValidAuthIdentity rejects malformed and oversized emails', () => {
  const validLabelsButTooLong = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`
  const invalidEmails = [
    '',
    'plain-address',
    'a@b',
    'a@@example.com',
    '@example.com',
    'a@',
    '.a@example.com',
    'a.@example.com',
    'a..b@example.com',
    'a b@example.com',
    '用户@example.com',
    `${'a'.repeat(65)}@example.com`,
    'a@-example.com',
    'a@example-.com',
    'a@example..com',
    'a@example_domain.com',
    `a@${'b'.repeat(64)}.com`,
    `a@${'b'.repeat(249)}.com`,
    `${'a'.repeat(64)}@${validLabelsButTooLong}`
  ]

  for (const email of invalidEmails) {
    assert.equal(isValidAuthIdentity('email', email), false, email)
  }
})

test('isValidAuthIdentity preserves the existing phone format and isolates channels', () => {
  assert.equal(isValidAuthIdentity('phone', '13800138000'), true)
  assert.equal(isValidAuthIdentity('phone', '12800138000'), false)
  assert.equal(isValidAuthIdentity('phone', '1380013800'), false)
  assert.equal(isValidAuthIdentity('phone', 13800138000), false)
  assert.equal(isValidAuthIdentity('username', '13800138000'), false)
  assert.equal(isValidAuthIdentity(undefined, 'user@example.com'), false)
})

test('purposeForMode only maps modes that require verification codes', () => {
  assert.equal(purposeForMode('register'), 'register')
  assert.equal(purposeForMode('reset'), 'reset')
  assert.equal(purposeForMode('login'), undefined)
  assert.equal(purposeForMode('unknown'), undefined)
})

test('isValidAuthPassword applies mode minimums and a 72 UTF-8 byte maximum', () => {
  assert.equal(isValidAuthPassword('login', ''), false)
  assert.equal(isValidAuthPassword('login', 'x'), true)
  assert.equal(isValidAuthPassword('register', '12345'), false)
  assert.equal(isValidAuthPassword('register', '123456'), true)
  assert.equal(isValidAuthPassword('register', '😀'.repeat(3)), true)
  assert.equal(isValidAuthPassword('reset', '12345'), false)
  assert.equal(isValidAuthPassword('reset', '123456'), true)

  for (const mode of ['login', 'register', 'reset']) {
    assert.equal(isValidAuthPassword(mode, 'a'.repeat(72)), true, `${mode}: 72 ASCII bytes`)
    assert.equal(isValidAuthPassword(mode, 'a'.repeat(73)), false, `${mode}: 73 ASCII bytes`)
    assert.equal(isValidAuthPassword(mode, '中'.repeat(24)), true, `${mode}: 72 multibyte bytes`)
    assert.equal(isValidAuthPassword(mode, '中'.repeat(25)), false, `${mode}: 75 multibyte bytes`)
  }

  assert.equal(isValidAuthPassword('register', null), false)
  assert.equal(isValidAuthPassword('unknown', '123456'), false)
})

test('requestForAuthMode dispatches every supported channel and mode with exact arguments', async () => {
  const calls = []
  const fakeApi = {}
  for (const method of [
    'login',
    'register',
    'resetPassword',
    'emailLogin',
    'emailRegister',
    'emailResetPassword'
  ]) {
    fakeApi[method] = (...args) => {
      calls.push([method, ...args])
      return Promise.resolve(`${method}-result`)
    }
  }

  const cases = [
    ['phone', 'login', '13800138000', 'login', ['13800138000', 'secret'], 'login-result'],
    ['phone', 'register', '13800138000', 'register', ['13800138000', '654321', 'secret'], 'register-result'],
    ['phone', 'reset', '13800138000', 'resetPassword', ['13800138000', '654321', 'secret'], 'resetPassword-result'],
    ['email', 'login', ' User@Example.COM ', 'emailLogin', ['user@example.com', 'secret'], 'emailLogin-result'],
    ['email', 'register', ' User@Example.COM ', 'emailRegister', ['user@example.com', '654321', 'secret'], 'emailRegister-result'],
    ['email', 'reset', ' User@Example.COM ', 'emailResetPassword', ['user@example.com', '654321', 'secret'], 'emailResetPassword-result']
  ]

  for (const [channel, mode, identity, method, args, expected] of cases) {
    const result = await requestForAuthMode(fakeApi, {
      channel,
      mode,
      identity,
      code: '654321',
      password: 'secret'
    })
    assert.equal(result, expected)
    assert.deepEqual(calls.at(-1), [method, ...args])
  }
  assert.equal(calls.length, 6)
})

test('requestForAuthMode rejects unknown channels and modes without calling the API', () => {
  let callCount = 0
  const fakeApi = new Proxy({}, {
    get() {
      callCount += 1
      return () => undefined
    }
  })
  const base = { identity: 'user@example.com', code: '654321', password: 'secret' }

  assert.throws(
    () => requestForAuthMode(fakeApi, { ...base, channel: 'username', mode: 'login' }),
    { name: 'Error', message: 'Unsupported auth channel' }
  )
  assert.throws(
    () => requestForAuthMode(fakeApi, { ...base, channel: 'email', mode: 'unknown' }),
    { name: 'Error', message: 'Unsupported auth mode' }
  )
  assert.equal(callCount, 0)
})

test('email API methods send exact JSON requests without persisting credentials', async () => {
  const originalDescriptors = Object.fromEntries(
    ['localStorage', 'crypto', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  )
  const storage = new Map()
  const writes = []
  const requests = []
  const localStorage = {
    getItem(key) {
      return storage.get(key) ?? null
    },
    setItem(key, value) {
      const text = String(value)
      storage.set(key, text)
      writes.push([key, text])
    },
    removeItem(key) {
      storage.delete(key)
    }
  }
  const fetch = async (path, options) => {
    requests.push({ path, options })
    return {
      headers: { get: () => null },
      json: async () => ({ ok: true, path })
    }
  }

  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, writable: true, value: localStorage },
    crypto: { configurable: true, writable: true, value: { randomUUID: () => 'test-device-id' } },
    fetch: { configurable: true, writable: true, value: fetch }
  })

  try {
    await api.emailSendCode('user@example.com', 'register')
    await api.emailRegister('user@example.com', '654321', 'register-secret')
    await api.emailLogin('user@example.com', 'login-secret')
    await api.emailResetPassword('user@example.com', '123456', 'reset-secret')

    assert.deepEqual(
      requests.map(({ path, options }) => ({
        path,
        method: options.method,
        body: JSON.parse(options.body)
      })),
      [
        {
          path: '/api/auth/email/send-code',
          method: 'POST',
          body: { email: 'user@example.com', purpose: 'register' }
        },
        {
          path: '/api/auth/email/register',
          method: 'POST',
          body: { email: 'user@example.com', code: '654321', password: 'register-secret' }
        },
        {
          path: '/api/auth/email/login',
          method: 'POST',
          body: { email: 'user@example.com', password: 'login-secret' }
        },
        {
          path: '/api/auth/email/reset-password',
          method: 'POST',
          body: { email: 'user@example.com', code: '123456', password: 'reset-secret' }
        }
      ]
    )

    for (const { options } of requests) {
      assert.equal(options.headers['X-Device-Id'], 'test-device-id')
      assert.equal(options.headers['Content-Type'], 'application/json')
    }
    assert.deepEqual(writes, [['device_id', 'test-device-id']])
    const persisted = JSON.stringify([...storage.entries()])
    for (const sensitive of [
      'user@example.com',
      '654321',
      '123456',
      'register-secret',
      'login-secret',
      'reset-secret'
    ]) {
      assert.equal(persisted.includes(sensitive), false, sensitive)
    }
  } finally {
    for (const [name, descriptor] of Object.entries(originalDescriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
})
