import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  EmailVerificationError,
  createEmailVerificationService
} from '../src/services/emailVerificationService.js'

// This URL must name a dedicated or temporary test Redis database. The test
// never flushes Redis, but it does write short-lived HMAC-keyed test state.
const redisUrl = process.env.EMAIL_AUTH_REDIS_URL?.trim() ?? ''

async function scanKeys(redis) {
  const keys = []
  let cursor = '0'
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'COUNT', 100)
    cursor = nextCursor
    keys.push(...batch)
  } while (cursor !== '0')
  return new Set(keys)
}

async function readNewEntries(redis, before) {
  const after = await scanKeys(redis)
  const newKeys = [...after].filter(key => !before.has(key))
  const entries = []
  for (const key of newKeys) {
    const type = await redis.type(key)
    entries.push([key, type === 'string' ? await redis.get(key) : `[${type}]`])
  }
  return { keys: new Set(newKeys), entries }
}

function expectTtlNear(actual, expected, tolerance = 5) {
  assert.ok(
    actual <= expected && actual >= expected - tolerance,
    `expected TTL ${actual} to be within ${tolerance}s of ${expected}`
  )
}

test('email verification security works atomically against real Redis', {
  skip: redisUrl ? false : 'EMAIL_AUTH_REDIS_URL is not set; real Redis test skipped'
}, async () => {
  assert.ok(
    /^rediss?:\/\//.test(redisUrl),
    'EMAIL_AUTH_REDIS_URL must use redis:// or rediss:// and point to a dedicated test Redis database'
  )

  const runId = randomUUID().replaceAll('-', '')
  const secret = `integration-${runId}-email-auth-secret`
  const initialEmail = `initial-${runId}@example.com`
  const initialIp = `2001:db8:${runId.slice(0, 4)}:${runId.slice(4, 8)}::1`
  const saturatedIp = `2001:db8:${runId.slice(8, 12)}:${runId.slice(12, 16)}::2`
  const cleanIp = `2001:db8:${runId.slice(16, 20)}:${runId.slice(20, 24)}::3`
  const limitedIps = Array.from({ length: 6 }, (_, index) =>
    `2001:db8:${runId.slice(24, 28)}:${runId.slice(28, 32)}::${index + 10}`
  )
  const targetEmail = `target-${runId}@example.com`
  const limitedEmail = `limited-${runId}@example.com`
  const loginEmail = `login-${runId}@example.com`
  const sent = []
  const expectedKeys = new Set()
  const rawEmails = new Set()
  const rawIps = new Set()
  let redis
  let connected = false
  let bodyError
  let finalizationError
  let before = new Set()

  const digest = value => createHmac('sha256', secret).update(value).digest('hex')
  const identity = email => digest(`email:${email.toLowerCase()}`)
  const ipIdentity = ip => digest(`ip:${ip}`)
  const rememberSendKeys = (email, purpose, ip) => {
    rawEmails.add(email)
    rawIps.add(ip)
    const emailIdentity = identity(email)
    expectedKeys.add(`email:cooldown:${purpose}:${emailIdentity}`)
    expectedKeys.add(`email:otp:${purpose}:${emailIdentity}`)
    expectedKeys.add(`email:attempts:${purpose}:${emailIdentity}`)
    expectedKeys.add(`email:rate:address:${emailIdentity}`)
    expectedKeys.add(`email:rate:ip:${ipIdentity(ip)}`)
  }
  const rememberLoginKey = email => {
    rawEmails.add(email)
    const key = `login:lock:email:${identity(email)}`
    expectedKeys.add(key)
    return key
  }
  const expectNoRawState = entries => {
    const state = JSON.stringify(entries).toLowerCase()
    for (const email of rawEmails) {
      assert.equal(state.includes(email.toLowerCase()), false, 'Redis state exposed a raw test email')
    }
    for (const ip of rawIps) {
      assert.equal(state.includes(ip.toLowerCase()), false, 'Redis state exposed a raw test IP')
    }
    assert.equal(state.includes('123456'), false, 'Redis state exposed the fixed test OTP')
  }

  try {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1
    })
    redis.on('error', () => {})
    await redis.connect()
    connected = true
    before = await scanKeys(redis)

    const service = createEmailVerificationService({
      getRedis: () => redis,
      secret,
      mailer: {
        async sendVerificationCode(message) {
          sent.push(message)
        }
      },
      randomIntFn: () => 123456
    })
    const sendCode = async payload => {
      rememberSendKeys(payload.email, payload.purpose, payload.ip)
      return service.sendCode(payload)
    }

    await sendCode({
      email: initialEmail,
      purpose: 'register',
      ip: initialIp
    })
    const initialCode = sent.at(-1).code
    const initialIdentity = identity(initialEmail)
    const initialKeys = {
      cooldown: `email:cooldown:register:${initialIdentity}`,
      otp: `email:otp:register:${initialIdentity}`,
      attempts: `email:attempts:register:${initialIdentity}`,
      addressRate: `email:rate:address:${initialIdentity}`,
      ipRate: `email:rate:ip:${ipIdentity(initialIp)}`
    }

    const initialState = await readNewEntries(redis, before)
    assert.equal(Object.values(initialKeys).every(key => initialState.keys.has(key)), true)
    assert.match(initialKeys.otp, /^email:otp:register:[a-f0-9]{64}$/)
    expectNoRawState(initialState.entries)

    expectTtlNear(await redis.ttl(initialKeys.otp), 300)
    expectTtlNear(await redis.ttl(initialKeys.attempts), 300)
    expectTtlNear(await redis.ttl(initialKeys.cooldown), 60)
    expectTtlNear(await redis.ttl(initialKeys.addressRate), 3600)
    expectTtlNear(await redis.ttl(initialKeys.ipRate), 3600)

    const consumeResults = await Promise.all([
      service.consumeCode({ email: initialEmail, purpose: 'register', code: initialCode }),
      service.consumeCode({ email: initialEmail, purpose: 'register', code: initialCode })
    ])
    assert.equal(consumeResults.filter(result => result.success).length, 1)
    assert.equal(consumeResults.filter(result => !result.success).length, 1)

    const loginKey = rememberLoginKey(loginEmail)
    assert.equal(await service.recordLoginFailure(loginEmail), 1)
    assert.equal(await service.recordLoginFailure(loginEmail), 2)
    const loginLock = await service.getLoginLock(loginEmail)
    assert.equal(loginLock.count, 2)
    expectTtlNear(loginLock.ttl, 900)
    const loginState = await readNewEntries(redis, before)
    assert.equal(loginState.keys.has(loginKey), true)
    assert.equal(before.has(loginKey), false)
    expectNoRawState(loginState.entries)
    await service.clearSecurityState(loginEmail)
    assert.deepEqual(await service.getLoginLock(loginEmail), { count: 0, ttl: 0 })

    const beforeAddressLimitMail = sent.length
    for (let index = 0; index < 5; index += 1) {
      await sendCode({
        email: limitedEmail,
        purpose: 'register',
        ip: limitedIps[index]
      })
      assert.deepEqual(await service.consumeCode({
        email: limitedEmail,
        purpose: 'register',
        code: sent.at(-1).code
      }), { success: true })
    }
    assert.equal(sent.length, beforeAddressLimitMail + 5)
    await assert.rejects(
      sendCode({ email: limitedEmail, purpose: 'register', ip: limitedIps[5] }),
      error => error instanceof EmailVerificationError && error.code === 'rate_limited'
    )
    assert.equal(sent.length, beforeAddressLimitMail + 5)

    for (let index = 0; index < 20; index += 1) {
      await sendCode({
        email: `seed-${index}-${runId}@example.com`,
        purpose: 'register',
        ip: saturatedIp
      })
    }
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        sendCode({ email: targetEmail, purpose: 'register', ip: saturatedIp }),
        error => error instanceof EmailVerificationError && error.code === 'rate_limited'
      )
    }
    await sendCode({ email: targetEmail, purpose: 'register', ip: cleanIp })
    assert.equal(sent.at(-1).to, targetEmail)

    const finalState = await readNewEntries(redis, before)
    expectNoRawState(finalState.entries)
  } catch (error) {
    bodyError = error
  } finally {
    if (connected) {
      try {
        const after = await scanKeys(redis)
        const cleanupKeys = [...expectedKeys].filter(key => !before.has(key) && after.has(key))
        if (cleanupKeys.length > 0) await redis.del(...cleanupKeys)
      } catch (error) {
        finalizationError ??= error
      }
      try {
        await redis.quit()
      } catch (error) {
        finalizationError ??= error
      }
    }
    try {
      redis?.disconnect()
    } catch (error) {
      finalizationError ??= error
    }
  }

  if (bodyError) throw bodyError
  if (finalizationError) throw finalizationError
})
