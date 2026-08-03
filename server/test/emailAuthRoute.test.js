import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { EmailVerificationError } from '../src/services/emailVerificationService.js'
import { createEmailAuthRouter } from '../src/routes/emailAuth.js'

const INVALID_CREDENTIALS = { success: false, error: '邮箱或密码错误' }
const LOGIN_LOCKED = { success: false, error: '登录尝试次数过多，请 15 分钟后重试' }
const INVALID_CODE = { success: false, error: '验证码无效或已过期' }
const RESET_ACCEPTED = {
  success: true,
  message: '如果该邮箱已注册，验证码将发送到你的邮箱'
}

function createDependencies() {
  const events = []
  const loggerCalls = []
  const accounts = {
    async findByEmail(email) {
      events.push(['findByEmail', email])
      return undefined
    },
    async createEmailAccount(input) {
      events.push(['createEmailAccount', input])
      return 17
    },
    async completeLogin(userId, deviceId) {
      events.push(['completeLogin', userId, deviceId])
    },
    async updatePassword(userId, passwordHash) {
      events.push(['updatePassword', userId, passwordHash])
      return 1
    }
  }
  const verification = {
    async sendCode(input) {
      events.push(['sendCode', input])
      return { success: true }
    },
    async consumeCode(input) {
      events.push(['consumeCode', input])
      return { success: true }
    },
    async getLoginLock(email) {
      events.push(['getLoginLock', email])
      return { count: 0, ttl: 0 }
    },
    async recordLoginFailure(email) {
      events.push(['recordLoginFailure', email])
      return 1
    },
    async clearSecurityState(email) {
      events.push(['clearSecurityState', email])
    }
  }
  const deps = {
    accounts,
    verification,
    async hashPassword(password, rounds) {
      events.push(['hashPassword', password, rounds])
      return 'password-hash'
    },
    async comparePassword(password, hash) {
      events.push(['comparePassword', password, hash])
      return true
    },
    sign(userId) {
      events.push(['sign', userId])
      return `token-${userId}`
    },
    now() {
      events.push(['now'])
      return '2026-08-03T10:00:00.000Z'
    },
    logger: {
      error(message, extra) {
        loggerCalls.push(['error', message, extra])
      },
      warn(message, extra) {
        loggerCalls.push(['warn', message, extra])
      },
      info(message, extra) {
        loggerCalls.push(['info', message, extra])
      }
    }
  }
  return { deps, events, loggerCalls }
}

function buildRouter(deps) {
  assert.equal(
    typeof createEmailAuthRouter,
    'function',
    'createEmailAuthRouter must be implemented'
  )
  return createEmailAuthRouter(deps)
}

async function request(deps, path, body, headers = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = req.get('x-device-id')
    next()
  })
  app.use(buildRouter(deps))

  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    return {
      status: response.status,
      body: await response.json()
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settleWithin(promise, timeoutMs = 1000) {
  let timer
  try {
    return await Promise.race([
      promise.then(value => ({ settled: true, value })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ settled: false }), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function flushBackgroundWork() {
  await new Promise(resolve => setImmediate(resolve))
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

test('email auth router exposes all four POST endpoints', () => {
  const { deps } = createDependencies()
  const routes = buildRouter(deps).stack
    .filter(layer => layer.route)
    .map(layer => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`)

  assert.deepEqual(routes, [
    'POST /send-code',
    'POST /register',
    'POST /login',
    'POST /reset-password'
  ])
})

test('invalid request bodies return 400 without touching downstream dependencies', async t => {
  const cases = [
    ['/send-code', { email: 'not-an-email', purpose: 'register' }],
    ['/send-code', { email: 'person@example.com', purpose: 'login' }],
    ['/register', { email: 'person@example.com', code: 123456, password: 'secret1' }],
    ['/register', { email: 'person@example.com', code: '123456', password: 123456 }],
    ['/reset-password', { email: 'person@example.com', code: 123456, password: 'secret1' }],
    ['/reset-password', { email: 'person@example.com', code: '123456', password: 123456 }],
    ['/login', { email: 'person@example.com', password: 123456 }],
    ['/login', { email: 'person@example.com', password: '' }]
  ]

  for (const [path, body] of cases) {
    await t.test(`${path} ${JSON.stringify(body)}`, async () => {
      const { deps, events } = createDependencies()
      const result = await request(deps, path, body)
      assert.equal(result.status, 400)
      assert.deepEqual(events, [])
    })
  }
})

test('password endpoints reject inputs beyond bcrypt 72-byte limit without side effects', async t => {
  const endpoints = [
    ['/register', password => ({ email: 'person@example.com', code: '123456', password })],
    ['/reset-password', password => ({ email: 'person@example.com', code: '123456', password })],
    ['/login', password => ({ email: 'person@example.com', password })]
  ]
  const overLimitPasswords = [
    ['73 ASCII bytes', 'a'.repeat(73)],
    ['75 UTF-8 bytes', '密'.repeat(25)]
  ]

  for (const [path, bodyFor] of endpoints) {
    for (const [name, password] of overLimitPasswords) {
      await t.test(`${path} rejects ${name}`, async () => {
        const { deps, events } = createDependencies()
        const result = await request(deps, path, bodyFor(password))

        assert.equal(Buffer.byteLength(password, 'utf8') > 72, true)
        assert.equal(result.status, 400)
        assert.deepEqual(events, [])
      })
    }
  }
})

test('password endpoints allow exactly 72 UTF-8 bytes into their normal dependency flow', async t => {
  const password = '密'.repeat(24)
  assert.equal(Buffer.byteLength(password, 'utf8'), 72)
  const cases = [
    ['/register', { email: 'person@example.com', code: '123456', password }, 'consumeCode'],
    ['/reset-password', { email: 'person@example.com', code: '123456', password }, 'consumeCode'],
    ['/login', { email: 'person@example.com', password }, 'getLoginLock']
  ]

  for (const [path, body, expectedEvent] of cases) {
    await t.test(path, async () => {
      const { deps, events } = createDependencies()
      await request(deps, path, body)

      assert.equal(events.some(([event]) => event === expectedEvent), true)
    })
  }
})

test('reset send-code returns 202 before account lookup settles', async () => {
  const { deps, events } = createDependencies()
  const lookup = createDeferred()
  deps.accounts.findByEmail = email => {
    events.push(['findByEmail', email])
    return lookup.promise
  }

  const requestPromise = request(deps, '/send-code', {
    email: 'person@example.com',
    purpose: 'reset'
  })
  const outcome = await settleWithin(requestPromise)
  lookup.resolve(undefined)
  const result = await requestPromise
  await flushBackgroundWork()

  assert.equal(outcome.settled, true)
  assert.deepEqual(result, { status: 202, body: RESET_ACCEPTED })
  assert.equal(events.some(([event]) => event === 'sendCode'), false)
})

test('reset send-code returns 202 before verified-account delivery settles', async () => {
  const { deps, events } = createDependencies()
  const delivery = createDeferred()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 1, email_verified_at: '2026-08-01' }
  }
  deps.verification.sendCode = input => {
    events.push(['sendCode', input])
    return delivery.promise
  }

  const requestPromise = request(deps, '/send-code', {
    email: 'person@example.com',
    purpose: 'reset'
  })
  const outcome = await settleWithin(requestPromise)
  delivery.resolve({ success: true })
  const result = await requestPromise
  await flushBackgroundWork()

  assert.equal(outcome.settled, true)
  assert.deepEqual(result, { status: 202, body: RESET_ACCEPTED })
  assert.equal(events.filter(([event]) => event === 'sendCode').length, 1)
})

test('reset send-code never reveals account or delivery state', async t => {
  const outcomes = []
  const cases = [
    {
      name: 'missing account',
      user: undefined,
      expectedSends: 0
    },
    {
      name: 'unverified account',
      user: { id: 1, email_verified_at: null },
      expectedSends: 0
    },
    {
      name: 'verified account',
      user: { id: 1, email_verified_at: '2026-08-01' },
      expectedSends: 1
    },
    {
      name: 'smtp failure',
      user: { id: 1, email_verified_at: '2026-08-01' },
      sendError: Object.assign(new Error('private smtp failure'), { code: 'ETIMEDOUT' }),
      expectedSends: 1
    },
    {
      name: 'rate failure',
      user: { id: 1, email_verified_at: '2026-08-01' },
      sendError: new EmailVerificationError('rate_limited', 'too frequent'),
      expectedSends: 1
    }
  ]

  for (const current of cases) {
    await t.test(current.name, async () => {
      const { deps, events, loggerCalls } = createDependencies()
      deps.accounts.findByEmail = async email => {
        events.push(['findByEmail', email])
        return current.user
      }
      deps.verification.sendCode = async input => {
        events.push(['sendCode', input])
        if (current.sendError) throw current.sendError
      }

      const result = await request(deps, '/send-code', {
        email: '  Person@Example.COM ',
        purpose: 'reset'
      }, { 'x-forwarded-for': '203.0.113.7' })
      await flushBackgroundWork()

      outcomes.push(JSON.stringify(result))
      assert.equal(result.status, 202)
      assert.deepEqual(result.body, RESET_ACCEPTED)
      assert.equal(events.filter(([name]) => name === 'sendCode').length, current.expectedSends)
      if (current.sendError) {
        assert.deepEqual(loggerCalls, [[
          'warn',
          'Reset email verification delivery skipped',
          {
            operation: 'send-reset-code',
            email: 'person@example.com',
            reason: current.sendError.code
          }
        ]])
        assert.equal(JSON.stringify(loggerCalls).includes(current.sendError.message), false)
      } else {
        assert.deepEqual(loggerCalls, [])
      }
    })
  }

  assert.equal(new Set(outcomes).size, 1)
})

test('reset send-code catches background lookup failures with safe diagnostics', async () => {
  const { deps, loggerCalls } = createDependencies()
  const privateMessage = 'lookup failed password=secret1 code=123456'
  deps.accounts.findByEmail = async () => {
    throw Object.assign(new Error(privateMessage), { code: 'ER_CONNECTION_LOST' })
  }

  const result = await request(deps, '/send-code', {
    email: 'person@example.com',
    purpose: 'reset'
  })
  await flushBackgroundWork()

  assert.deepEqual(result, { status: 202, body: RESET_ACCEPTED })
  assert.deepEqual(loggerCalls, [[
    'warn',
    'Reset email verification delivery skipped',
    {
      operation: 'send-reset-code',
      email: 'person@example.com',
      reason: 'ER_CONNECTION_LOST'
    }
  ]])
  assert.equal(JSON.stringify(loggerCalls).includes(privateMessage), false)
  assert.equal(JSON.stringify(loggerCalls).includes('123456'), false)
  assert.equal(JSON.stringify(loggerCalls).includes('secret1'), false)
})

test('register send-code normalizes email and forwards the request ip', async () => {
  const { deps, events } = createDependencies()

  const result = await request(deps, '/send-code', {
    email: '  Person@Example.COM ',
    purpose: 'register'
  }, { 'x-device-id': 'guest-device' })

  assert.deepEqual(result, {
    status: 200,
    body: { success: true, message: '验证码已发送' }
  })
  assert.deepEqual(events, [
    ['findByEmail', 'person@example.com'],
    ['sendCode', { email: 'person@example.com', purpose: 'register', ip: '127.0.0.1' }]
  ])
})

test('register send-code rejects an existing account before sending', async () => {
  const { deps, events } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 4 }
  }

  const result = await request(deps, '/send-code', {
    email: 'person@example.com',
    purpose: 'register'
  })

  assert.deepEqual(result, {
    status: 409,
    body: { success: false, error: '该邮箱已注册，请直接登录' }
  })
  assert.equal(events.some(([name]) => name === 'sendCode'), false)
})

test('register send-code maps throttling to 429 and delivery failures to 503', async t => {
  const cases = [
    ['cooldown', 429],
    ['rate_limited', 429],
    ['delivery_failed', 503],
    ['generation_failed', 503],
    ['service_unavailable', 503]
  ]

  for (const [code, status] of cases) {
    await t.test(code, async () => {
      const { deps, loggerCalls } = createDependencies()
      deps.verification.sendCode = async () => {
        throw new EmailVerificationError(code, `safe-${code}`)
      }
      const result = await request(deps, '/send-code', {
        email: 'person@example.com',
        purpose: 'register'
      })
      assert.equal(result.status, status)
      assert.deepEqual(result.body, { success: false, error: `safe-${code}` })
      assert.deepEqual(loggerCalls, [[
        'warn',
        'Registration email verification delivery failed',
        {
          operation: 'send-register-code',
          email: 'person@example.com',
          reason: code
        }
      ]])
    })
  }

  await t.test('unknown delivery error', async () => {
    const { deps } = createDependencies()
    deps.verification.sendCode = async () => {
      throw new Error('private transport details')
    }
    const result = await request(deps, '/send-code', {
      email: 'person@example.com',
      purpose: 'register'
    })
    assert.deepEqual(result, {
      status: 503,
      body: { success: false, error: '邮件暂时无法发送，请稍后重试' }
    })
  })
})

test('register verifies purpose before hashing and creates the account with normalized data', async () => {
  const { deps, events, loggerCalls } = createDependencies()

  const result = await request(deps, '/register', {
    email: '  Person@Example.COM ',
    code: '012345',
    password: 'secret1'
  }, { 'x-device-id': 'guest-device' })

  assert.deepEqual(result, {
    status: 200,
    body: { success: true, data: { token: 'token-17', userId: 17 } }
  })
  assert.deepEqual(events, [
    ['findByEmail', 'person@example.com'],
    ['consumeCode', { email: 'person@example.com', purpose: 'register', code: '012345' }],
    ['hashPassword', 'secret1', 10],
    ['now'],
    ['createEmailAccount', {
      email: 'person@example.com',
      passwordHash: 'password-hash',
      nickname: 'p***n@example.com',
      verifiedAt: '2026-08-03T10:00:00.000Z',
      deviceId: 'guest-device'
    }],
    ['sign', 17]
  ])
  assert.deepEqual(loggerCalls, [[
    'info',
    'Email registration succeeded',
    { userId: 17, email: 'person@example.com' }
  ]])
})

test('register does not consume a code when the email already exists', async () => {
  const { deps, events } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 3 }
  }

  const result = await request(deps, '/register', {
    email: 'person@example.com',
    code: '123456',
    password: 'secret1'
  })

  assert.equal(result.status, 409)
  assert.deepEqual(result.body, { success: false, error: '该邮箱已注册，请直接登录' })
  assert.deepEqual(events, [['findByEmail', 'person@example.com']])
})

test('register does not hash or create when code consumption fails', async () => {
  const { deps, events } = createDependencies()
  deps.verification.consumeCode = async input => {
    events.push(['consumeCode', input])
    return { success: false, message: '验证码无效或已过期' }
  }

  const result = await request(deps, '/register', {
    email: 'person@example.com',
    code: '123456',
    password: 'secret1'
  })

  assert.deepEqual(result, { status: 400, body: INVALID_CODE })
  assert.deepEqual(events, [
    ['findByEmail', 'person@example.com'],
    ['consumeCode', { email: 'person@example.com', purpose: 'register', code: '123456' }]
  ])
})

test('register maps an insert race to the same duplicate response', async () => {
  const { deps } = createDependencies()
  deps.accounts.createEmailAccount = async () => {
    throw Object.assign(new Error('duplicate private detail'), { code: 'ER_DUP_ENTRY' })
  }

  const result = await request(deps, '/register', {
    email: 'person@example.com',
    code: '123456',
    password: 'secret1'
  })

  assert.deepEqual(result, {
    status: 409,
    body: { success: false, error: '该邮箱已注册，请直接登录' }
  })
})

test('all invalid login identities run exactly one password comparison and return the same response', async t => {
  const cases = [
    ['unknown', undefined, true],
    ['unverified', { id: 2, password: 'real-unverified-hash', email_verified_at: null }, true],
    ['no password hash', { id: 2, password: null, email_verified_at: '2026-08-01' }, true],
    ['wrong password', { id: 2, password: 'real-verified-hash', email_verified_at: '2026-08-01' }, false]
  ]

  for (const [name, user, comparison] of cases) {
    await t.test(name, async () => {
      const { deps, events } = createDependencies()
      deps.accounts.findByEmail = async email => {
        events.push(['findByEmail', email])
        return user
      }
      deps.comparePassword = async (password, hash) => {
        events.push(['comparePassword', password, hash])
        return comparison
      }

      const result = await request(deps, '/login', {
        email: 'person@example.com',
        password: 'secret1'
      })

      assert.deepEqual(result, { status: 401, body: INVALID_CREDENTIALS })
      const comparisons = events.filter(([event]) => event === 'comparePassword')
      assert.equal(comparisons.length, 1)
      if (name === 'wrong password') {
        assert.equal(comparisons[0][2], 'real-verified-hash')
      } else {
        assert.notEqual(comparisons[0][2], user?.password)
      }
      assert.equal(events.filter(([event]) => event === 'recordLoginFailure').length, 1)
    })
  }
})

test('the fifth failed login returns the lock response immediately', async () => {
  const { deps, events } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 2, password: 'real-hash', email_verified_at: '2026-08-01' }
  }
  deps.comparePassword = async (password, hash) => {
    events.push(['comparePassword', password, hash])
    return false
  }
  deps.verification.recordLoginFailure = async email => {
    events.push(['recordLoginFailure', email])
    return 5
  }

  const result = await request(deps, '/login', {
    email: 'person@example.com',
    password: 'wrong1'
  })

  assert.deepEqual(result, { status: 429, body: LOGIN_LOCKED })
  assert.equal(events.filter(([event]) => event === 'recordLoginFailure').length, 1)
})

test('a prelocked login returns a fixed 15-minute message without account lookup or comparison', async () => {
  const { deps, events } = createDependencies()
  deps.verification.getLoginLock = async email => {
    events.push(['getLoginLock', email])
    return { count: 5, ttl: 17 }
  }

  const result = await request(deps, '/login', {
    email: 'person@example.com',
    password: 'secret1'
  })

  assert.deepEqual(result, { status: 429, body: LOGIN_LOCKED })
  assert.deepEqual(events, [['getLoginLock', 'person@example.com']])
})

test('successful login clears security state before completing login and signing', async () => {
  const { deps, events } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 8, password: 'real-hash', email_verified_at: '2026-08-01' }
  }

  const result = await request(deps, '/login', {
    email: ' Person@Example.COM ',
    password: 'secret1'
  }, { 'x-device-id': 'guest-device' })

  assert.deepEqual(result, {
    status: 200,
    body: { success: true, data: { token: 'token-8', userId: 8 } }
  })
  assert.deepEqual(events, [
    ['getLoginLock', 'person@example.com'],
    ['findByEmail', 'person@example.com'],
    ['comparePassword', 'secret1', 'real-hash'],
    ['clearSecurityState', 'person@example.com'],
    ['completeLogin', 8, 'guest-device'],
    ['sign', 8]
  ])
})

test('reset consumes a reset-purpose code before account lookup and does not hash on failure', async () => {
  const { deps, events } = createDependencies()
  deps.verification.consumeCode = async input => {
    events.push(['consumeCode', input])
    return { success: false, message: '验证码无效或已过期' }
  }

  const result = await request(deps, '/reset-password', {
    email: 'person@example.com',
    code: '654321',
    password: 'newpass'
  })

  assert.deepEqual(result, { status: 400, body: INVALID_CODE })
  assert.deepEqual(events, [[
    'consumeCode',
    { email: 'person@example.com', purpose: 'reset', code: '654321' }
  ]])
})

test('reset returns the same invalid-code response when a consumed code has no verified account', async t => {
  for (const user of [undefined, { id: 4, email_verified_at: null }]) {
    await t.test(user ? 'unverified' : 'unknown', async () => {
      const { deps, events } = createDependencies()
      deps.accounts.findByEmail = async email => {
        events.push(['findByEmail', email])
        return user
      }
      const result = await request(deps, '/reset-password', {
        email: 'person@example.com',
        code: '654321',
        password: 'newpass'
      })
      assert.deepEqual(result, { status: 400, body: INVALID_CODE })
      assert.deepEqual(events.map(([event]) => event), ['consumeCode', 'findByEmail'])
    })
  }
})

test('successful reset hashes, updates and clears state in order', async () => {
  const { deps, events, loggerCalls } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 8, email_verified_at: '2026-08-01' }
  }

  const result = await request(deps, '/reset-password', {
    email: ' Person@Example.COM ',
    code: '654321',
    password: 'newpass'
  })

  assert.deepEqual(result, {
    status: 200,
    body: { success: true, message: '密码重置成功，请使用新密码登录' }
  })
  assert.deepEqual(events, [
    ['consumeCode', { email: 'person@example.com', purpose: 'reset', code: '654321' }],
    ['findByEmail', 'person@example.com'],
    ['hashPassword', 'newpass', 10],
    ['clearSecurityState', 'person@example.com'],
    ['updatePassword', 8, 'password-hash']
  ])
  assert.deepEqual(loggerCalls, [[
    'info',
    'Email password reset succeeded',
    { userId: 8, email: 'person@example.com' }
  ]])
})

test('default router uses the database clock for verification timestamps', async () => {
  const source = await readFile(new URL('../src/routes/emailAuth.js', import.meta.url), 'utf8')

  assert.match(source, /now:\s*\(\)\s*=>\s*db\.fn\.now\(\)/)
})

test('reset does not update the password when clearing security state fails', async () => {
  const { deps, events, loggerCalls } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 8, email_verified_at: '2026-08-01' }
  }
  deps.verification.clearSecurityState = async email => {
    events.push(['clearSecurityState', email])
    throw Object.assign(new Error('private redis detail'), { code: 'REDIS_DOWN' })
  }

  const result = await request(deps, '/reset-password', {
    email: 'person@example.com',
    code: '654321',
    password: 'newpass'
  })

  assert.deepEqual(result, {
    status: 500,
    body: { success: false, error: '服务暂时不可用，请稍后重试' }
  })
  assert.equal(events.some(([event]) => event === 'updatePassword'), false)
  assert.deepEqual(loggerCalls, [[
    'error',
    'Email authentication operation failed',
    { operation: 'reset-password', errorCode: 'REDIS_DOWN' }
  ]])
})

test('reset never reports success when no password row was updated', async () => {
  const { deps, events, loggerCalls } = createDependencies()
  deps.accounts.findByEmail = async email => {
    events.push(['findByEmail', email])
    return { id: 8, email_verified_at: '2026-08-01' }
  }
  deps.accounts.updatePassword = async (userId, passwordHash) => {
    events.push(['updatePassword', userId, passwordHash])
    return 0
  }

  const result = await request(deps, '/reset-password', {
    email: 'person@example.com',
    code: '654321',
    password: 'newpass'
  })

  assert.deepEqual(result, {
    status: 500,
    body: { success: false, error: '服务暂时不可用，请稍后重试' }
  })
  assert.equal(events.some(([event]) => event === 'clearSecurityState'), true)
  assert.equal(loggerCalls.length, 1)
})

test('unexpected failures use a fixed 500 boundary without logging raw secrets', async () => {
  const { deps, loggerCalls } = createDependencies()
  const secretMessage = 'DB failure password=secret1 code=123456 for person@example.com'
  deps.accounts.createEmailAccount = async () => {
    throw Object.assign(new Error(secretMessage), { code: 'ER_CONNECTION_LOST' })
  }

  const result = await request(deps, '/register', {
    email: 'person@example.com',
    code: '123456',
    password: 'secret1'
  })

  assert.deepEqual(result, {
    status: 500,
    body: { success: false, error: '服务暂时不可用，请稍后重试' }
  })
  assert.equal(loggerCalls.length, 1)
  assert.equal(loggerCalls[0][0], 'error')
  assert.deepEqual(loggerCalls[0][2], {
    operation: 'register',
    errorCode: 'ER_CONNECTION_LOST'
  })
  const serialized = JSON.stringify(loggerCalls)
  assert.equal(serialized.includes(secretMessage), false)
  assert.equal(serialized.includes('secret1'), false)
  assert.equal(serialized.includes('123456'), false)
  assert.equal(serialized.includes('person@example.com'), false)
})
