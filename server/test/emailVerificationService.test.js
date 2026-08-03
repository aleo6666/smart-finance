import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EmailVerificationError,
  createEmailVerificationService,
  isValidEmail,
  maskEmail,
  normalizeEmail
} from '../src/services/emailVerificationService.js'

const SECRET = 'test-secret-with-at-least-thirty-two-characters'
const INVALID_CODE_RESULT = {
  success: false,
  message: '验证码无效或已过期'
}

class FakeRedis {
  constructor({ status = 'ready', failures = [], consumeResult } = {}) {
    this.status = status
    this.failures = new Set(failures)
    this.consumeResult = consumeResult
    this.calls = []
    this.values = new Map()
    this.expiries = new Map()
    this.connectCount = 0
  }

  fail(method) {
    if (this.failures.has(method)) throw new Error(`Redis ${method} failed`)
  }

  async connect() {
    this.fail('connect')
    this.connectCount += 1
    this.status = 'ready'
  }

  async get(key) {
    this.fail('get')
    this.calls.push(['get', key])
    return this.values.get(key) ?? null
  }

  async ttl(key) {
    this.fail('ttl')
    this.calls.push(['ttl', key])
    if (!this.values.has(key)) return -2
    return this.expiries.get(key) ?? -1
  }

  async set(key, value, ...options) {
    this.fail('set')
    this.calls.push(['set', key, value, ...options])
    const exclusive = options.includes('NX')
    if (exclusive && this.values.has(key)) return null

    const expiryIndex = options.indexOf('EX')
    this.values.set(key, String(value))
    if (expiryIndex >= 0) this.expiries.set(key, Number(options[expiryIndex + 1]))
    return 'OK'
  }

  async del(...keys) {
    this.fail('del')
    this.calls.push(['del', ...keys])
    let deleted = 0
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1
      this.expiries.delete(key)
    }
    return deleted
  }

  async incr(key) {
    this.fail('incr')
    this.calls.push(['incr', key])
    const next = Number(this.values.get(key) ?? 0) + 1
    this.values.set(key, String(next))
    return next
  }

  async expire(key, seconds) {
    this.fail('expire')
    this.calls.push(['expire', key, seconds])
    if (!this.values.has(key)) return 0
    this.expiries.set(key, Number(seconds))
    return 1
  }

  multi() {
    const redis = this
    const queued = []
    const chain = {
      set(...args) { queued.push(['set', args]); return chain },
      get(...args) { queued.push(['get', args]); return chain },
      ttl(...args) { queued.push(['ttl', args]); return chain },
      del(...args) { queued.push(['del', args]); return chain },
      incr(...args) { queued.push(['incr', args]); return chain },
      expire(...args) { queued.push(['expire', args]); return chain },
      async exec() {
        redis.fail('multiExec')
        redis.calls.push(['multiExec', queued.map(([method]) => method)])
        const results = []
        for (const [method, args] of queued) {
          try {
            results.push([null, await redis[method](...args)])
          } catch (error) {
            results.push([error, null])
          }
        }
        return results
      }
    }
    return chain
  }

  async eval(script, keyCount, ...args) {
    this.fail('eval')
    this.calls.push(['eval', script, keyCount, ...args])
    const keys = args.slice(0, keyCount)
    const argv = args.slice(keyCount)

    if (script.includes('email-verification:rate-limit')) {
      const current = await this.incr(keys[0])
      if (current === 1) await this.expire(keys[0], Number(argv[0]))
      return current
    }

    if (script.includes('email-verification:login-failure')) {
      const current = await this.incr(keys[0])
      await this.expire(keys[0], Number(argv[0]))
      return current
    }

    if (!script.includes('email-verification:consume')) {
      throw new Error('Unknown Redis script')
    }
    if (this.consumeResult !== undefined) return this.consumeResult

    const [otpKey, attemptsKey, cooldownKey] = keys
    const [candidateDigest, ttl, maximumAttempts] = argv
    const storedDigest = this.values.get(otpKey)
    if (!storedDigest) return 0

    const attempts = Number(this.values.get(attemptsKey) ?? 0) + 1
    this.calls.push(['incr', attemptsKey])
    this.values.set(attemptsKey, String(attempts))
    this.calls.push(['expire', attemptsKey, Number(ttl)])
    this.expiries.set(attemptsKey, Number(ttl))
    if (storedDigest === candidateDigest) {
      this.calls.push(['del', otpKey, attemptsKey, cooldownKey])
      for (const key of [otpKey, attemptsKey, cooldownKey]) {
        this.values.delete(key)
        this.expiries.delete(key)
      }
      return 1
    }
    if (attempts >= Number(maximumAttempts)) {
      this.calls.push(['del', otpKey, attemptsKey, cooldownKey])
      for (const key of [otpKey, attemptsKey, cooldownKey]) {
        this.values.delete(key)
        this.expiries.delete(key)
      }
    }
    return -1
  }
}

function createHarness({ redis = new FakeRedis(), randomIntFn = () => 42, mailer } = {}) {
  const sent = []
  const resolvedMailer = mailer ?? {
    async sendVerificationCode(message) {
      sent.push(message)
    }
  }
  const service = createEmailVerificationService({
    getRedis: () => redis,
    secret: SECRET,
    mailer: resolvedMailer,
    randomIntFn
  })
  return { redis, sent, service }
}

function sendPayload(overrides = {}) {
  return {
    email: 'user@example.com',
    purpose: 'register',
    ip: '203.0.113.10',
    ...overrides
  }
}

test('email helpers normalize, validate, and safely mask identities', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com')
  assert.equal(normalizeEmail(null), '')
  assert.equal(isValidEmail('user@example.com'), true)
  assert.equal(isValidEmail(' user@example.com '), true)
  assert.equal(isValidEmail('bad-address'), false)
  assert.equal(isValidEmail('a@b'), false)
  assert.equal(isValidEmail(`a@${'x'.repeat(250)}.com`), false)
  assert.equal(maskEmail('user@example.com'), 'u***r@example.com')
  assert.equal(maskEmail('a@example.com'), 'a***@example.com')
  assert.equal(maskEmail('not-an-email'), '***')
})

test('service rejects missing or non-string HMAC secrets with a stable error', () => {
  for (const secret of [undefined, null, '', '   ', 123, Symbol('secret')]) {
    assert.throws(
      () => createEmailVerificationService({
        getRedis: () => new FakeRedis(),
        secret,
        mailer: { sendVerificationCode: async () => {} }
      }),
      { name: 'Error', message: 'Email verification secret is required' }
    )
  }
})

test('EmailVerificationError exposes a stable machine-readable code', () => {
  const error = new EmailVerificationError('cooldown', '请 60 秒后再试')
  assert.equal(error.name, 'EmailVerificationError')
  assert.equal(error.code, 'cooldown')
  assert.equal(error.message, '请 60 秒后再试')
})

test('sendCode generates six digits and stores only HMAC identities and digest', async () => {
  const { redis, sent, service } = createHarness()

  assert.deepEqual(await service.sendCode(sendPayload({
    email: ' User@Example.COM '
  })), { success: true })
  assert.deepEqual(sent, [{
    to: 'user@example.com',
    code: '000042',
    purpose: 'register'
  }])

  const redisState = JSON.stringify({
    calls: redis.calls,
    values: [...redis.values],
    expiries: [...redis.expiries]
  })
  assert.doesNotMatch(redisState, /user@example\.com/i)
  assert.doesNotMatch(redisState, /203\.0\.113\.10/)
  assert.doesNotMatch(redisState, /000042/)
  assert.match(redisState, /email:otp:register:[a-f0-9]{64}/)
  assert.match(redisState, /email:rate:ip:[a-f0-9]{64}/)
})

test('sendCode sets exact cooldown, rate, OTP, and attempts TTLs', async () => {
  const { redis, service } = createHarness({ randomIntFn: () => 123456 })
  await service.sendCode(sendPayload())

  const cooldownCall = redis.calls.find(call => call[0] === 'set' && call[1].startsWith('email:cooldown:'))
  assert.deepEqual(cooldownCall.slice(2), ['1', 'EX', 60, 'NX'])
  const otpCalls = redis.calls.filter(call => call[0] === 'set' && (
    call[1].startsWith('email:otp:') || call[1].startsWith('email:attempts:')
  ))
  assert.equal(otpCalls.length, 2)
  assert.equal(otpCalls.every(call => call.at(-2) === 'EX' && call.at(-1) === 300), true)
  const rateCalls = redis.calls.filter(call => call[0] === 'eval' && call[1].includes('rate-limit'))
  assert.equal(rateCalls.length, 2)
  assert.equal(rateCalls.every(call => call.at(-1) === 3600), true)
})

test('sendCode enforces an atomic purpose-specific cooldown', async () => {
  const { service, sent } = createHarness({ randomIntFn: () => 123456 })
  await service.sendCode(sendPayload())

  await assert.rejects(
    service.sendCode(sendPayload()),
    error => error instanceof EmailVerificationError &&
      error.code === 'cooldown' && error.message === '请 60 秒后再试'
  )
  assert.equal(sent.length, 1)
})

test('sendCode limits an address to five sends per hour', async () => {
  const { service, sent } = createHarness({ randomIntFn: () => 123456 })
  for (let index = 0; index < 5; index += 1) {
    await service.sendCode(sendPayload())
    assert.deepEqual(await service.consumeCode({
      email: 'user@example.com',
      purpose: 'register',
      code: '123456'
    }), { success: true })
  }

  await assert.rejects(
    service.sendCode(sendPayload()),
    error => error.code === 'rate_limited' && error.message === '请求过于频繁，请稍后重试'
  )
  assert.equal(sent.length, 5)
})

test('sendCode limits an IP identity to twenty sends per hour', async () => {
  const { service, sent } = createHarness({ randomIntFn: () => 123456 })
  for (let index = 0; index < 20; index += 1) {
    await service.sendCode(sendPayload({ email: `user${index}@example.com` }))
  }

  await assert.rejects(
    service.sendCode(sendPayload({ email: 'user20@example.com' })),
    error => error.code === 'rate_limited'
  )
  assert.equal(sent.length, 20)
})

test('register and reset OTP state is isolated and each code is single-use', async () => {
  let nextCode = 111111
  const { service } = createHarness({
    randomIntFn: () => nextCode++ === 111111 ? 111111 : 222222
  })
  await service.sendCode(sendPayload({ purpose: 'register' }))
  await service.sendCode(sendPayload({ purpose: 'reset' }))

  assert.deepEqual(await service.consumeCode({
    email: 'user@example.com', purpose: 'reset', code: '111111'
  }), INVALID_CODE_RESULT)
  assert.deepEqual(await service.consumeCode({
    email: 'user@example.com', purpose: 'reset', code: '222222'
  }), { success: true })
  assert.deepEqual(await service.consumeCode({
    email: 'user@example.com', purpose: 'register', code: '111111'
  }), { success: true })
  assert.deepEqual(await service.consumeCode({
    email: 'user@example.com', purpose: 'register', code: '111111'
  }), INVALID_CODE_RESULT)
})

test('concurrent consumeCode calls can succeed only once', async () => {
  const { service } = createHarness({ randomIntFn: () => 123456 })
  await service.sendCode(sendPayload())

  const results = await Promise.all([
    service.consumeCode({ email: 'user@example.com', purpose: 'register', code: '123456' }),
    service.consumeCode({ email: 'user@example.com', purpose: 'register', code: '123456' })
  ])
  assert.equal(results.filter(result => result.success).length, 1)
  assert.equal(results.filter(result => !result.success).length, 1)
})

test('consumeCode deletes OTP state on the fifth wrong attempt', async () => {
  const { redis, service } = createHarness({ randomIntFn: () => 123456 })
  await service.sendCode(sendPayload({ purpose: 'reset' }))

  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await service.consumeCode({
      email: 'user@example.com', purpose: 'reset', code: '000000'
    }), INVALID_CODE_RESULT)
  }
  assert.deepEqual(await service.consumeCode({
    email: 'user@example.com', purpose: 'reset', code: '123456'
  }), INVALID_CODE_RESULT)
  assert.equal([...redis.values.keys()].some(key => key.startsWith('email:otp:reset:')), false)
  assert.equal([...redis.values.keys()].some(key => key.startsWith('email:attempts:reset:')), false)
  assert.equal([...redis.values.keys()].some(key => key.startsWith('email:cooldown:reset:')), false)
})

test('consumeCode maps invalid inputs and unknown Redis outcomes to one response', async t => {
  let redisRequests = 0
  const service = createEmailVerificationService({
    getRedis: () => {
      redisRequests += 1
      return new FakeRedis()
    },
    secret: SECRET,
    mailer: { sendVerificationCode: async () => {} }
  })
  for (const payload of [
    { email: 'bad', purpose: 'register', code: '123456' },
    { email: 'user@example.com', purpose: 'other', code: '123456' },
    { email: 'user@example.com', purpose: 'register', code: '12345' },
    { email: 'user@example.com', purpose: 'register', code: '１２３４５６' },
    { email: 'user@example.com', purpose: 'register', code: 123456 }
  ]) {
    await t.test(JSON.stringify(payload), async () => {
      assert.deepEqual(await service.consumeCode(payload), INVALID_CODE_RESULT)
    })
  }
  assert.equal(redisRequests, 0)

  const unknown = createHarness({ redis: new FakeRedis({ consumeResult: 42 }) }).service
  assert.deepEqual(await unknown.consumeCode({
    email: 'user@example.com', purpose: 'register', code: '123456'
  }), INVALID_CODE_RESULT)
})

test('sendCode rejects invalid inputs without touching Redis or mail', async t => {
  let redisRequests = 0
  let mailCalls = 0
  const service = createEmailVerificationService({
    getRedis: () => {
      redisRequests += 1
      return new FakeRedis()
    },
    secret: SECRET,
    mailer: { sendVerificationCode: async () => { mailCalls += 1 } }
  })
  const cases = [
    [sendPayload({ email: 'bad' }), 'invalid_email', '邮箱格式不正确'],
    [sendPayload({ purpose: 'login' }), 'invalid_purpose', '验证码用途不正确'],
    [sendPayload({ purpose: Symbol('register') }), 'invalid_purpose', '验证码用途不正确']
  ]
  for (const [payload, code, message] of cases) {
    await t.test(code, async () => {
      await assert.rejects(
        service.sendCode(payload),
        error => error.code === code && error.message === message
      )
    })
  }
  assert.equal(redisRequests, 0)
  assert.equal(mailCalls, 0)
})

test('delivery failure clears OTP, attempts, and cooldown with a fixed error', async () => {
  const redis = new FakeRedis()
  const service = createHarness({
    redis,
    randomIntFn: () => 654321,
    mailer: {
      async sendVerificationCode() {
        throw new Error('provider unavailable for user@example.com code 654321')
      }
    }
  }).service

  await assert.rejects(
    service.sendCode(sendPayload({ purpose: 'reset' })),
    error => error.code === 'delivery_failed' &&
      error.message === '邮件暂时无法发送，请稍后重试' &&
      !error.message.includes('provider')
  )
  assert.equal([...redis.values.keys()].some(key => /email:(otp|attempts|cooldown):reset:/.test(key)), false)
  assert.doesNotMatch(JSON.stringify(redis.calls), /user@example\.com|654321/)
})

test('Redis write failures fail closed and never call the mailer', async () => {
  let mailCalls = 0
  const { service } = createHarness({
    redis: new FakeRedis({ failures: ['multiExec'] }),
    mailer: { sendVerificationCode: async () => { mailCalls += 1 } }
  })

  await assert.rejects(
    service.sendCode(sendPayload()),
    error => error.code === 'service_unavailable'
  )
  assert.equal(mailCalls, 0)
})

test('Redis connection failures fail closed instead of becoming invalid-code responses', async () => {
  const redisError = new FakeRedis({ status: 'wait', failures: ['connect'] })
  const service = createHarness({ redis: redisError }).service

  await assert.rejects(
    service.sendCode(sendPayload()),
    error => error.code === 'service_unavailable'
  )
  await assert.rejects(
    service.consumeCode({ email: 'user@example.com', purpose: 'register', code: '123456' }),
    error => error.code === 'service_unavailable'
  )
})

test('a waiting Redis client is connected before use', async () => {
  const redis = new FakeRedis({ status: 'wait' })
  const { service } = createHarness({ redis })
  await service.sendCode(sendPayload())
  assert.equal(redis.connectCount, 1)
})

test('invalid random generator outcomes never write or mail an OTP', async t => {
  for (const outcome of [-1, 1000000, 1.5, '42', Number.NaN, new Error('rng unavailable')]) {
    await t.test(String(outcome), async () => {
      const redis = new FakeRedis()
      let mailCalls = 0
      const randomIntFn = outcome instanceof Error
        ? () => { throw outcome }
        : () => outcome
      const service = createHarness({
        redis,
        randomIntFn,
        mailer: { sendVerificationCode: async () => { mailCalls += 1 } }
      }).service

      await assert.rejects(
        service.sendCode(sendPayload()),
        error => error.code === 'generation_failed'
      )
      assert.equal(mailCalls, 0)
      assert.equal([...redis.values.keys()].some(key => key.startsWith('email:otp:')), false)
    })
  }
})

test('login failure state is HMAC-keyed, atomic, expires, and can be cleared with reset state', async () => {
  const { redis, service } = createHarness({ randomIntFn: () => 123456 })
  await service.sendCode(sendPayload({ purpose: 'reset' }))
  assert.equal(await service.recordLoginFailure(' User@Example.COM '), 1)
  assert.equal(await service.recordLoginFailure('user@example.com'), 2)
  assert.deepEqual(await service.getLoginLock('user@example.com'), { count: 2, ttl: 900 })

  const loginEvalCalls = redis.calls.filter(call => call[0] === 'eval' && call[1].includes('login-failure'))
  assert.equal(loginEvalCalls.length, 2)
  assert.doesNotMatch(JSON.stringify(loginEvalCalls), /user@example\.com/i)
  assert.equal([...redis.expiries].some(([key, ttl]) => key.startsWith('login:lock:email:') && ttl === 900), true)

  await service.clearSecurityState('user@example.com')
  assert.deepEqual(await service.getLoginLock('user@example.com'), { count: 0, ttl: 0 })
  assert.equal([...redis.values.keys()].some(key => /^(login:lock:email|email:(otp|attempts|cooldown):reset):/.test(key)), false)
})
