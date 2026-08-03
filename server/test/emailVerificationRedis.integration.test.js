import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  EmailVerificationError,
  createEmailVerificationService
} from '../src/services/emailVerificationService.js'

const redisUrl = process.env.EMAIL_AUTH_REDIS_URL

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

function expectTtlNear(actual, expected, tolerance = 5) {
  assert.ok(
    actual <= expected && actual >= expected - tolerance,
    `expected TTL ${actual} to be within ${tolerance}s of ${expected}`
  )
}

test('email verification security works atomically against real Redis', {
  skip: redisUrl ? false : 'EMAIL_AUTH_REDIS_URL is not set; real Redis test skipped'
}, async () => {
  const runId = randomUUID().replaceAll('-', '')
  const secret = `integration-${runId}-email-auth-secret`
  const initialEmail = `initial-${runId}@example.com`
  const initialIp = `2001:db8:${runId.slice(0, 4)}:${runId.slice(4, 8)}::1`
  const saturatedIp = `2001:db8:${runId.slice(8, 12)}:${runId.slice(12, 16)}::2`
  const cleanIp = `2001:db8:${runId.slice(16, 20)}:${runId.slice(20, 24)}::3`
  const targetEmail = `target-${runId}@example.com`
  const loginEmail = `login-${runId}@example.com`
  const sent = []
  const expectedKeys = new Set()
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1
  })
  redis.on('error', () => {})

  const digest = value => createHmac('sha256', secret).update(value).digest('hex')
  const identity = email => digest(`email:${email.toLowerCase()}`)
  const ipIdentity = ip => digest(`ip:${ip}`)
  const rememberSendKeys = (email, purpose, ip) => {
    const emailIdentity = identity(email)
    expectedKeys.add(`email:cooldown:${purpose}:${emailIdentity}`)
    expectedKeys.add(`email:otp:${purpose}:${emailIdentity}`)
    expectedKeys.add(`email:attempts:${purpose}:${emailIdentity}`)
    expectedKeys.add(`email:rate:address:${emailIdentity}`)
    expectedKeys.add(`email:rate:ip:${ipIdentity(ip)}`)
  }
  const rememberLoginKey = email => {
    expectedKeys.add(`login:lock:email:${identity(email)}`)
  }

  let before = new Set()
  try {
    await redis.connect()
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

    const afterInitialSend = await scanKeys(redis)
    const newlyAdded = [...afterInitialSend].filter(key => !before.has(key))
    const newEntries = await Promise.all(newlyAdded.map(async key => [key, await redis.get(key)]))
    const serializedState = JSON.stringify(newEntries)
    assert.equal(Object.values(initialKeys).every(key => afterInitialSend.has(key)), true)
    assert.match(initialKeys.otp, /^email:otp:register:[a-f0-9]{64}$/)
    assert.doesNotMatch(serializedState, new RegExp(initialEmail, 'i'))
    assert.doesNotMatch(serializedState, new RegExp(initialIp.replaceAll(':', '\\:'), 'i'))
    assert.doesNotMatch(serializedState, new RegExp(initialCode))

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

    rememberLoginKey(loginEmail)
    assert.equal(await service.recordLoginFailure(loginEmail), 1)
    assert.equal(await service.recordLoginFailure(loginEmail), 2)
    const loginLock = await service.getLoginLock(loginEmail)
    assert.equal(loginLock.count, 2)
    expectTtlNear(loginLock.ttl, 900)
    await service.clearSecurityState(loginEmail)
    assert.deepEqual(await service.getLoginLock(loginEmail), { count: 0, ttl: 0 })

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
  } finally {
    try {
      const after = await scanKeys(redis)
      const cleanupKeys = [...expectedKeys].filter(key => !before.has(key) && after.has(key))
      if (cleanupKeys.length > 0) await redis.del(...cleanupKeys)
    } finally {
      await redis.quit()
    }
  }
})
