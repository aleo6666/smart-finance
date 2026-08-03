# Smart Finance Email Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add verified email/password registration, login, and email-code password reset without changing the existing phone and WeChat authentication contracts.

**Architecture:** Mount a separate Express router at /api/auth/email. Keep SMTP delivery, Redis-backed verification state, and database account operations behind focused injectable services so they can be tested without external systems. Reuse the existing bcrypt, JWT, default-ledger, and guest-record flows, while the Vue login card switches between email and phone channels.

**Tech Stack:** Node.js 22, Express 4, Knex/MySQL 8, Redis/ioredis, nodemailer, bcryptjs, JWT, Vue 3, Vite, Node built-in test runner.

---

## Assumptions and success criteria

- The public Web login page opens on the email channel because real SMS delivery is not available; users can still switch to the unchanged phone channel.
- Passwords retain the current minimum length of 6 and bcrypt cost 10. Changing the global password policy is outside this feature.
- Existing phone, WeChat, and guest users are not linked to new email accounts.
- Production startup requires all SMTP variables and an independent EMAIL_OTP_SECRET of at least 32 characters.
- Reset-code requests return the same accepted response for missing accounts, mail failures, cooldowns, and rate-limit outcomes. This is deliberate account-enumeration protection.
- The implementation is complete when targeted email-auth tests pass, the client builds, existing phone routes remain registered, schema upgrades are idempotent, and the full-suite failure count does not increase from the recorded baseline.

## File map

**Create**

- **server/src/services/emailService.js** — provider-neutral SMTP transport and fixed verification email content.
- **server/src/services/emailVerificationService.js** — email normalization, HMAC identifiers, Redis OTP state, rate limits, and login locks.
- **server/src/services/authAccount.js** — shared default-ledger/guest migration helpers and transactional email-account operations.
- **server/src/routes/emailAuth.js** — the four email-auth HTTP endpoints and dependency-injected router factory.
- **server/test/emailService.test.js** — SMTP message and failure tests.
- **server/test/emailVerificationService.test.js** — normalization, hashing, cooldown, rate, attempts, and atomic-consume tests.
- **server/test/authAccount.test.js** — account transaction and guest migration tests.
- **server/test/emailAuthRoute.test.js** — endpoint contract, enumeration, login-lock, and reset tests.
- **server/test/logger.test.js** — email and secret redaction regression tests.
- **client/src/utils/authForm.js** — pure channel-specific validation and request-selection helpers.
- **client/test/authForm.test.js** — Node tests for the pure login-form rules.

**Modify**

- **server/package.json**, **server/package-lock.json** — add nodemailer.
- **server/src/config.js**, **server/test/config.test.js**, **server/.env.example**, **docker-compose.yml** — load, validate, document, and inject SMTP/OTP configuration.
- **server/src/schema.js**, **server/test/schema.test.js** — add email columns and idempotent existing-database upgrade.
- **server/src/routes/auth.js** — import shared account helpers and include email fields in /me; phone endpoint paths and payloads stay unchanged.
- **server/src/index.js**, **server/test/indexRouteRegistration.test.js** — mount /api/auth/email.
- **server/src/utils/logger.js** — redact complete email values.
- **client/src/utils/api.js** — add four email-auth client methods.
- **client/src/components/LoginPage.vue** — add channel switch and email flows.
- **README.md** — document supported login modes and personal SMTP setup.

## Task 1: Add typed email configuration and the SMTP dependency

**Files:**

- Modify: **server/src/config.js**
- Modify: **server/test/config.test.js**
- Modify: **server/.env.example**
- Modify: **docker-compose.yml**
- Modify: **server/package.json**
- Modify: **server/package-lock.json**

- [ ] **Step 1: Write the failing configuration tests**

Append these tests to server/test/config.test.js:

~~~js
test('loadConfig reads email SMTP and OTP settings', () => {
  const loaded = loadConfig({
    SMTP_HOST: 'smtp.qq.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'sender@example.com',
    SMTP_PASS: 'smtp-app-password',
    MAIL_FROM: 'Smart Finance <sender@example.com>',
    EMAIL_OTP_SECRET: 'email-otp-secret-at-least-32-characters'
  })

  assert.deepEqual(loaded.email, {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: 'sender@example.com',
    pass: 'smtp-app-password',
    from: 'Smart Finance <sender@example.com>'
  })
  assert.equal(loaded.auth.emailOtpSecret, 'email-otp-secret-at-least-32-characters')
})

test('validateProductionConfig rejects incomplete email auth secrets', () => {
  const base = loadConfig({
    NODE_ENV: 'production',
    JWT_SECRET: 'jwt-secret-that-is-longer-than-thirty-two-characters',
    DB_PASSWORD: 'strong-db-password'
  })

  assert.throws(
    () => validateProductionConfig(base),
    /SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM and EMAIL_OTP_SECRET/
  )
})
~~~

Update the import to:

~~~js
const { loadConfig, validateProductionConfig } = await import('../src/config.js?config-test')
~~~

- [ ] **Step 2: Run the focused tests and confirm the new tests fail**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit --test-name-pattern "email SMTP|incomplete email" test/config.test.js
~~~

Expected: FAIL because loaded.email and validateProductionConfig do not exist.

- [ ] **Step 3: Add the configuration fields and exported production validation**

Add this sibling object after redis in loadConfig:

~~~js
email: {
  host: env.SMTP_HOST || '',
  port: numberFromEnv(env.SMTP_PORT, 465),
  secure: booleanFromEnv(env.SMTP_SECURE, true),
  user: env.SMTP_USER || '',
  pass: env.SMTP_PASS || '',
  from: env.MAIL_FROM || ''
},
~~~

Extend auth to:

~~~js
auth: {
  jwtSecret: env.JWT_SECRET || 'dev-secret-do-not-use-in-production-change-me-immediately',
  emailOtpSecret: env.EMAIL_OTP_SECRET || 'dev-email-otp-secret-change-me-immediately'
},
~~~

Replace the inline production block with:

~~~js
export function validateProductionConfig(configToValidate) {
  if (!configToValidate.auth.jwtSecret) {
    throw new Error('JWT_SECRET is required in production')
  }
  if (
    configToValidate.auth.jwtSecret.includes('change-me') ||
    configToValidate.auth.jwtSecret.length < 32
  ) {
    throw new Error('JWT_SECRET must be changed in production to a strong random string of at least 32 characters')
  }
  if (configToValidate.db.password === 'change-me-in-production') {
    throw new Error('DB_PASSWORD must be set in production to a strong custom password, cannot use default value')
  }

  const emailValues = [
    configToValidate.email.host,
    configToValidate.email.user,
    configToValidate.email.pass,
    configToValidate.email.from,
    configToValidate.auth.emailOtpSecret
  ]
  if (emailValues.some(value => !value)) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM and EMAIL_OTP_SECRET are required in production')
  }
  if (
    configToValidate.auth.emailOtpSecret.includes('change-me') ||
    configToValidate.auth.emailOtpSecret.length < 32
  ) {
    throw new Error('EMAIL_OTP_SECRET must be a strong random string of at least 32 characters')
  }
}

if (config.server.nodeEnv === 'production') {
  validateProductionConfig(config)
}
~~~

Make these exact edits in the default-object expectation in config.test.js:

~~~js
email: {
  host: '',
  port: 465,
  secure: true,
  user: '',
  pass: '',
  from: ''
},
~~~

~~~js
adminSql: {
  host: 'localhost',
  port: 3306,
  name: 'smart_finance',
  user: '',
  password: '',
  maxRows: 200,
  timeoutMs: 3000,
  maxRequestsPerMinute: 10
},
~~~

~~~js
auth: {
  jwtSecret: 'dev-secret-do-not-use-in-production-change-me-immediately',
  emailOtpSecret: 'dev-email-otp-secret-change-me-immediately'
},
~~~

- [ ] **Step 4: Document and inject the variables**

Add to server/.env.example:

~~~env
# Email verification (SMTP_PASS is the mailbox app authorization code)
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=sender@example.com
SMTP_PASS=replace-with-personal-mailbox-authorization-code
MAIL_FROM="Smart Finance <sender@example.com>"
EMAIL_OTP_SECRET=replace-with-independent-random-string-at-least-32-chars
~~~

Add these entries to docker-compose.yml under backend.environment:

~~~yaml
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-465}
      SMTP_SECURE: ${SMTP_SECURE:-true}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASS: ${SMTP_PASS:-}
      MAIL_FROM: ${MAIL_FROM:-}
      EMAIL_OTP_SECRET: ${EMAIL_OTP_SECRET:-}
~~~

- [ ] **Step 5: Install nodemailer and run the focused configuration tests**

Run:

~~~powershell
npm --prefix server install nodemailer
Set-Location server
node --test --test-force-exit --test-name-pattern "email SMTP|incomplete email" test/config.test.js
~~~

Expected: the two focused tests PASS and package-lock.json records nodemailer.

- [ ] **Step 6: Commit the configuration boundary**

~~~powershell
git add server/package.json server/package-lock.json server/src/config.js server/test/config.test.js server/.env.example docker-compose.yml
git commit -m "feat(auth): configure SMTP email verification"
~~~

## Task 2: Add an idempotent users-table email upgrade

**Files:**

- Modify: **server/src/schema.js**
- Modify: **server/test/schema.test.js**

- [ ] **Step 1: Write schema tests for new and existing databases**

Append to server/test/schema.test.js:

~~~js
test('users schema defines verified unique email identity', () => {
  const usersSql = getTableStatement('users')

  assert.match(usersSql, /email\s+VARCHAR\(254\)/)
  assert.match(usersSql, /email_verified_at\s+DATETIME NULL/)
  assert.match(usersSql, /UNIQUE KEY uniq_users_email \(email\)/)
})

test('ensureUserEmailSchema adds missing columns and unique index once', async () => {
  const operations = []
  const fakeDb = {
    schema: {
      hasColumn: async (_table, column) => column === 'email_verified_at',
      alterTable: async (_table, callback) => {
        callback({
          string(name, length) {
            operations.push(['string', name, length])
            return { nullable() {} }
          },
          dateTime(name) {
            operations.push(['dateTime', name])
            return { nullable() {} }
          },
          unique(columns, name) {
            operations.push(['unique', columns, name])
          }
        })
      }
    },
    raw: async () => [[]]
  }

  await ensureUserEmailSchema(fakeDb)

  assert.deepEqual(operations, [
    ['string', 'email', 254],
    ['unique', ['email'], 'uniq_users_email']
  ])
})
~~~

Update the schema test import:

~~~js
import { getCreateTableStatements, ensureUserEmailSchema } from '../src/schema.js'
~~~

- [ ] **Step 2: Verify the tests fail**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit --test-name-pattern "verified unique email|adds missing columns" test/schema.test.js
~~~

Expected: FAIL because the columns and ensureUserEmailSchema are absent.

- [ ] **Step 3: Extend the new-table SQL**

Add these clauses to the users table directly after phone:

~~~sql
      email VARCHAR(254),
      email_verified_at DATETIME NULL,
~~~

Add this index before idx_users_unionid:

~~~sql
      UNIQUE KEY uniq_users_email (email),
~~~

- [ ] **Step 4: Implement the idempotent upgrade**

Add before ensureSchema:

~~~js
export async function ensureUserEmailSchema(db) {
  const hasEmail = await db.schema.hasColumn('users', 'email')
  const hasVerifiedAt = await db.schema.hasColumn('users', 'email_verified_at')

  if (!hasEmail || !hasVerifiedAt) {
    await db.schema.alterTable('users', table => {
      if (!hasEmail) table.string('email', 254).nullable()
      if (!hasVerifiedAt) table.dateTime('email_verified_at').nullable()
    })
  }

  const [indexes] = await db.raw(
    "SHOW INDEX FROM users WHERE Key_name = 'uniq_users_email'"
  )
  if (indexes.length === 0) {
    await db.schema.alterTable('users', table => {
      table.unique(['email'], 'uniq_users_email')
    })
  }
}
~~~

Call it after the create-table loop:

~~~js
export async function ensureSchema(db) {
  for (const statement of getCreateTableStatements()) {
    await db.raw(statement)
  }
  await ensureUserEmailSchema(db)
}
~~~

- [ ] **Step 5: Run schema tests twice to prove idempotent behavior**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/schema.test.js
node --test --test-force-exit test/schema.test.js
~~~

Expected: PASS on both runs.

- [ ] **Step 6: Commit the additive schema change**

~~~powershell
git add server/src/schema.js server/test/schema.test.js
git commit -m "feat(auth): add verified email identity schema"
~~~

## Task 3: Extract account operations and preserve phone behavior

**Files:**

- Create: **server/src/services/authAccount.js**
- Create: **server/test/authAccount.test.js**
- Modify: **server/src/routes/auth.js**

- [ ] **Step 1: Write a transactional account-service test**

Create server/test/authAccount.test.js with:

~~~js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthAccountService } from '../src/services/authAccount.js'

test('createEmailAccount commits user and default ledger before guest migration', async () => {
  const inserts = []
  const updates = []

  function fakeDb(table) {
    return {
      where(criteria) {
        this.criteria = criteria
        return this
      },
      first: async () => undefined,
      insert: async row => {
        inserts.push([table, row])
        return table === 'users' ? [41] : [91]
      },
      update: async row => {
        updates.push([table, this.criteria, row])
        return 2
      }
    }
  }
  fakeDb.transaction = async callback => callback(fakeDb)
  fakeDb.fn = { now: () => 'NOW' }

  const accounts = createAuthAccountService(fakeDb)
  const userId = await accounts.createEmailAccount({
    email: 'user@example.com',
    passwordHash: 'hashed',
    nickname: 'u***r@example.com',
    verifiedAt: '2026-08-03 12:00:00',
    deviceId: 'guest-device'
  })

  assert.equal(userId, 41)
  assert.deepEqual(inserts, [
    ['users', {
      email: 'user@example.com',
      email_verified_at: '2026-08-03 12:00:00',
      password: 'hashed',
      nickname: 'u***r@example.com'
    }],
    ['ledgers', { user_id: 41, name: '我的账本', base_currency: 'CNY' }]
  ])
  assert.deepEqual(updates, [
    ['records', { device_id: 'guest-device', user_id: null }, { user_id: 41 }]
  ])
})
~~~

- [ ] **Step 2: Run the test and confirm it fails**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/authAccount.test.js
~~~

Expected: FAIL because authAccount.js is absent.

- [ ] **Step 3: Implement the shared account service**

Create server/src/services/authAccount.js:

~~~js
import db from '../db.js'

export async function createDefaultLedger(userId, database = db) {
  const existing = await database('ledgers').where({ user_id: userId }).first()
  if (!existing) {
    await database('ledgers').insert({
      user_id: userId,
      name: '我的账本',
      base_currency: 'CNY'
    })
  }
}

export async function migrateGuestRecords(userId, deviceId, database = db) {
  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') return 0
  return database('records')
    .where({ device_id: deviceId, user_id: null })
    .update({ user_id: userId })
}

export function createAuthAccountService(database = db) {
  return {
    findByEmail(email) {
      return database('users').where({ email }).first()
    },

    async createEmailAccount({ email, passwordHash, nickname, verifiedAt, deviceId }) {
      const userId = await database.transaction(async trx => {
        const [createdId] = await trx('users').insert({
          email,
          email_verified_at: verifiedAt,
          password: passwordHash,
          nickname
        })
        await createDefaultLedger(createdId, trx)
        return createdId
      })
      await migrateGuestRecords(userId, deviceId, database)
      return userId
    },

    async completeLogin(userId, deviceId) {
      await database('users').where({ id: userId }).update({
        last_login_at: database.fn.now()
      })
      await migrateGuestRecords(userId, deviceId, database)
    },

    updatePassword(userId, passwordHash) {
      return database('users').where({ id: userId }).update({ password: passwordHash })
    }
  }
}
~~~

- [ ] **Step 4: Make the phone router use the shared helpers**

Import the helpers in server/src/routes/auth.js:

~~~js
import { createDefaultLedger, migrateGuestRecords } from '../services/authAccount.js'
~~~

Delete only the two local helper definitions with the same names. Do not change any phone, WeChat, mock-login, bind-phone, or WeChat-MP route path or payload.

- [ ] **Step 5: Run account and phone-oriented regressions**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/authAccount.test.js test/authMiddleware.test.js test/wechat.test.js test/smokeLocal.test.js
~~~

Expected: PASS.

- [ ] **Step 6: Commit the shared account boundary**

~~~powershell
git add server/src/services/authAccount.js server/test/authAccount.test.js server/src/routes/auth.js
git commit -m "refactor(auth): share account setup operations"
~~~

## Task 4: Add safe SMTP delivery and email log redaction

**Files:**

- Create: **server/src/services/emailService.js**
- Create: **server/test/emailService.test.js**
- Create: **server/test/logger.test.js**
- Modify: **server/src/utils/logger.js**

- [ ] **Step 1: Write delivery and redaction tests**

Create server/test/emailService.test.js:

~~~js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmailService } from '../src/services/emailService.js'

test('email service sends fixed verification content through injected transport', async () => {
  let message
  const service = createEmailService({
    transport: { sendMail: async value => { message = value; return { messageId: 'm1' } } },
    from: 'Smart Finance <sender@example.com>'
  })

  await service.sendVerificationCode({
    to: 'user@example.com',
    code: '483920',
    purpose: 'register'
  })

  assert.equal(message.to, 'user@example.com')
  assert.equal(message.from, 'Smart Finance <sender@example.com>')
  assert.match(message.subject, /注册验证码/)
  assert.match(message.text, /483920/)
  assert.match(message.text, /5 分钟/)
  assert.doesNotMatch(message.html, /user@example\.com/)
})

test('email service propagates transport failure to its caller', async () => {
  const service = createEmailService({
    transport: {
      sendMail: async () => {
        throw new Error('SMTP unavailable')
      }
    },
    from: 'Smart Finance <sender@example.com>'
  })

  await assert.rejects(
    service.sendVerificationCode({
      to: 'user@example.com',
      code: '483920',
      purpose: 'reset'
    }),
    /SMTP unavailable/
  )
})
~~~

Create server/test/logger.test.js:

~~~js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../src/utils/logger.js'

test('logger masks email and redacts SMTP credentials', () => {
  const original = console.error
  let line = ''
  console.error = value => { line = String(value) }
  try {
    createLogger('EmailAuth').error('send failed', {
      email: 'user@example.com',
      smtpPass: 'secret-authorization-code'
    })
  } finally {
    console.error = original
  }

  assert.doesNotMatch(line, /user@example\.com/)
  assert.doesNotMatch(line, /secret-authorization-code/)
  assert.match(line, /u\*+r@example\.com/)
  assert.match(line, /REDACTED/)
})
~~~

- [ ] **Step 2: Run the tests and confirm failure**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/emailService.test.js test/logger.test.js
~~~

Expected: FAIL because emailService.js is absent and logger exposes complete email values.

- [ ] **Step 3: Implement provider-neutral delivery**

Create server/src/services/emailService.js:

~~~js
import nodemailer from 'nodemailer'

const PURPOSE_LABEL = {
  register: '注册',
  reset: '重置密码'
}

export function createEmailService({ transport, from }) {
  return {
    async sendVerificationCode({ to, code, purpose }) {
      const label = PURPOSE_LABEL[purpose]
      if (!label) throw new Error('Unsupported email verification purpose')

      return transport.sendMail({
        from,
        to,
        subject: 'Smart Finance ' + label + '验证码',
        text: '你的验证码是 ' + code + '，5 分钟内有效。请勿向任何人泄露此验证码。',
        html:
          '<p>你的验证码是：</p>' +
          '<p style="font-size:28px;font-weight:700;letter-spacing:6px">' + code + '</p>' +
          '<p>验证码 5 分钟内有效，请勿向任何人泄露。</p>'
      })
    }
  }
}

export function createSmtpEmailService(emailConfig) {
  const transport = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: {
      user: emailConfig.user,
      pass: emailConfig.pass
    }
  })
  return createEmailService({ transport, from: emailConfig.from })
}
~~~

- [ ] **Step 4: Mask email fields in the logger**

Add this function to server/src/utils/logger.js:

~~~js
function maskEmail(value) {
  const [local, domain] = String(value).split('@')
  if (!local || !domain) return mask(value)
  if (local.length === 1) return local + '***@' + domain
  return local[0] + '***' + local.at(-1) + '@' + domain
}
~~~

Add this branch immediately after phone handling:

~~~js
} else if (key === 'email' && typeof cleaned[key] === 'string') {
  cleaned[key] = maskEmail(cleaned[key])
~~~

The existing sensitive-key branch already redacts smtpPass because its key contains pass only after adding pass to SENSITIVE_KEYS. Extend the constant to:

~~~js
const SENSITIVE_KEYS = [
  'password', 'pass', 'secret', 'token', 'key', 'apiKey',
  'api_key', 'authorization', 'bearer', 'code', 'otp'
]
~~~

- [ ] **Step 5: Run the two tests**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/emailService.test.js test/logger.test.js
~~~

Expected: PASS; captured output contains only a masked email and redaction marker.

- [ ] **Step 6: Commit mail delivery and privacy logging**

~~~powershell
git add server/src/services/emailService.js server/test/emailService.test.js server/src/utils/logger.js server/test/logger.test.js
git commit -m "feat(auth): add secure SMTP verification delivery"
~~~

## Task 5: Implement Redis-backed verification and login security

**Files:**

- Create: **server/src/services/emailVerificationService.js**
- Create: **server/test/emailVerificationService.test.js**

- [ ] **Step 1: Write tests for normalization, HMAC storage, purpose isolation, and single use**

Create server/test/emailVerificationService.test.js. The fake records Redis calls and supplies deterministic script results:

~~~js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEmailVerificationService,
  normalizeEmail,
  isValidEmail,
  maskEmail
} from '../src/services/emailVerificationService.js'

function createRedisFake({ rateResults = [], consumeResults = [] } = {}) {
  const values = new Map()
  const calls = []
  return {
    status: 'ready',
    calls,
    values,
    async get(key) { return values.get(key) || null },
    async ttl() { return 900 },
    async set(key, value, ...args) {
      calls.push(['set', key, value, ...args])
      if (args.includes('NX') && values.has(key)) return null
      values.set(key, value)
      return 'OK'
    },
    async del(...keys) {
      calls.push(['del', ...keys])
      keys.forEach(key => values.delete(key))
      return keys.length
    },
    async incr(key) {
      const value = Number(values.get(key) || 0) + 1
      values.set(key, String(value))
      return value
    },
    async expire(key, ttl) {
      calls.push(['expire', key, ttl])
      return 1
    },
    multi() {
      const queued = []
      const chain = {
        set(...args) { queued.push(['set', args]); return chain },
        incr(...args) { queued.push(['incr', args]); return chain },
        expire(...args) { queued.push(['expire', args]); return chain },
        async exec() {
          for (const [method, args] of queued) await thisRedis[method](...args)
          return queued.map(() => [null, 'OK'])
        }
      }
      const thisRedis = this
      return chain
    },
    async eval(script, keyCount, ...args) {
      calls.push(['eval', keyCount, ...args])
      if (keyCount === 1) {
        return rateResults.length ? rateResults.shift() : this.incr(args[0])
      }
      return consumeResults.length ? consumeResults.shift() : 1
    }
  }
}

test('email identity helpers normalize, validate, and mask', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com')
  assert.equal(isValidEmail('user@example.com'), true)
  assert.equal(isValidEmail('bad-address'), false)
  assert.equal(maskEmail('user@example.com'), 'u***r@example.com')
})

test('sendCode stores only HMAC values and sends deterministic six-digit code', async () => {
  const redis = createRedisFake()
  const sent = []
  const verification = createEmailVerificationService({
    getRedis: () => redis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: { sendVerificationCode: async value => sent.push(value) },
    randomIntFn: () => 42
  })

  await verification.sendCode({
    email: ' User@Example.COM ',
    purpose: 'register',
    ip: '127.0.0.1'
  })

  assert.deepEqual(sent, [{
    to: 'user@example.com',
    code: '000042',
    purpose: 'register'
  }])
  const serialized = JSON.stringify(redis.calls)
  assert.doesNotMatch(serialized, /user@example\.com/)
  assert.doesNotMatch(serialized, /000042/)
})

test('consumeCode maps atomic Redis outcomes and separates purposes', async () => {
  const redis = createRedisFake()
  const verification = createEmailVerificationService({
    getRedis: () => redis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: { sendVerificationCode: async () => {} }
  })

  assert.deepEqual(
    await verification.consumeCode({
      email: 'user@example.com',
      purpose: 'reset',
      code: '123456'
    }),
    { success: true }
  )
  assert.match(JSON.stringify(redis.calls), /reset/)
  assert.doesNotMatch(JSON.stringify(redis.calls), /register/)
})
~~~

- [ ] **Step 2: Run the service tests and confirm failure**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/emailVerificationService.test.js
~~~

Expected: FAIL because emailVerificationService.js is absent.

- [ ] **Step 3: Implement constants, HMAC keys, and atomic Lua scripts**

Create server/src/services/emailVerificationService.js with these constants and helpers:

~~~js
import { createHmac, randomInt } from 'node:crypto'

const CODE_TTL = 300
const COOLDOWN_TTL = 60
const RATE_TTL = 3600
const MAX_ATTEMPTS = 5
const MAX_EMAIL_SENDS = 5
const MAX_IP_SENDS = 20
const LOGIN_LOCK_TTL = 900

const RATE_SCRIPT = [
  "local current = redis.call('INCR', KEYS[1])",
  "if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
  'return current'
].join('\n')

const CONSUME_SCRIPT = [
  "local stored = redis.call('GET', KEYS[1])",
  'if not stored then return 0 end',
  "local attempts = redis.call('INCR', KEYS[2])",
  "redis.call('EXPIRE', KEYS[2], ARGV[2])",
  'if attempts > tonumber(ARGV[3]) then',
  "  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
  '  return -2',
  'end',
  'if stored ~= ARGV[1] then',
  '  if attempts >= tonumber(ARGV[3]) then',
  "    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
  '  end',
  '  return -1',
  'end',
  "redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])",
  'return 1'
].join('\n')

export class EmailVerificationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function isValidEmail(value) {
  const email = normalizeEmail(value)
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function maskEmail(value) {
  const [local, domain] = normalizeEmail(value).split('@')
  if (!local || !domain) return '***'
  if (local.length === 1) return local + '***@' + domain
  return local[0] + '***' + local.at(-1) + '@' + domain
}
~~~

- [ ] **Step 4: Implement the injectable service**

Add the following export to the same file:

~~~js
export function createEmailVerificationService({
  getRedis,
  secret,
  mailer,
  randomIntFn = randomInt
}) {
  const digest = value => createHmac('sha256', secret).update(value).digest('hex')
  const identity = email => digest('email:' + normalizeEmail(email))
  const key = (kind, purpose, email) =>
    'email:' + kind + ':' + purpose + ':' + identity(email)

  async function redisClient() {
    const redis = getRedis()
    if (redis.status === 'wait') await redis.connect()
    return redis
  }

  async function enforceRate(redis, rateKey, limit) {
    const current = Number(await redis.eval(RATE_SCRIPT, 1, rateKey, RATE_TTL))
    if (current > limit) {
      throw new EmailVerificationError('rate_limited', '请求过于频繁，请稍后重试')
    }
  }

  return {
    async sendCode({ email, purpose, ip }) {
      const normalized = normalizeEmail(email)
      if (!isValidEmail(normalized)) {
        throw new EmailVerificationError('invalid_email', '邮箱格式不正确')
      }
      if (!['register', 'reset'].includes(purpose)) {
        throw new EmailVerificationError('invalid_purpose', '验证码用途不正确')
      }

      const redis = await redisClient()
      const cooldownKey = key('cooldown', purpose, normalized)
      const acquired = await redis.set(cooldownKey, '1', 'EX', COOLDOWN_TTL, 'NX')
      if (!acquired) {
        throw new EmailVerificationError('cooldown', '请 60 秒后再试')
      }

      try {
        await enforceRate(redis, 'email:rate:address:' + identity(normalized), MAX_EMAIL_SENDS)
        await enforceRate(redis, 'email:rate:ip:' + digest('ip:' + String(ip || 'unknown')), MAX_IP_SENDS)
      } catch (error) {
        await redis.del(cooldownKey)
        throw error
      }

      const code = String(randomIntFn(0, 1000000)).padStart(6, '0')
      const codeKey = key('otp', purpose, normalized)
      const attemptsKey = key('attempts', purpose, normalized)
      const codeDigest = digest(purpose + ':' + normalized + ':' + code)

      await redis.multi()
        .set(codeKey, codeDigest, 'EX', CODE_TTL)
        .set(attemptsKey, '0', 'EX', CODE_TTL)
        .exec()

      try {
        await mailer.sendVerificationCode({ to: normalized, code, purpose })
      } catch (error) {
        await redis.del(codeKey, attemptsKey, cooldownKey)
        throw new EmailVerificationError('delivery_failed', '邮件暂时无法发送，请稍后重试')
      }
      return { success: true }
    },

    async consumeCode({ email, purpose, code }) {
      const normalized = normalizeEmail(email)
      if (!/^\d{6}$/.test(String(code || ''))) {
        return { success: false, message: '验证码无效或已过期' }
      }
      const redis = await redisClient()
      const result = Number(await redis.eval(
        CONSUME_SCRIPT,
        3,
        key('otp', purpose, normalized),
        key('attempts', purpose, normalized),
        key('cooldown', purpose, normalized),
        digest(purpose + ':' + normalized + ':' + code),
        CODE_TTL,
        MAX_ATTEMPTS
      ))
      return result === 1
        ? { success: true }
        : { success: false, message: '验证码无效或已过期' }
    },

    async getLoginLock(email) {
      const redis = await redisClient()
      const lockKey = 'login:lock:email:' + identity(email)
      return {
        count: Number(await redis.get(lockKey) || 0),
        ttl: await redis.ttl(lockKey)
      }
    },

    async recordLoginFailure(email) {
      const redis = await redisClient()
      const lockKey = 'login:lock:email:' + identity(email)
      await redis.multi().incr(lockKey).expire(lockKey, LOGIN_LOCK_TTL).exec()
    },

    async clearSecurityState(email) {
      const redis = await redisClient()
      await redis.del(
        'login:lock:email:' + identity(email),
        key('otp', 'reset', email),
        key('attempts', 'reset', email),
        key('cooldown', 'reset', email)
      )
    }
  }
}
~~~

- [ ] **Step 5: Add exact cooldown, rate, delivery, attempts, and single-use tests**

Append:

~~~js
test('sendCode enforces cooldown and hourly address limit', async () => {
  const redis = createRedisFake()
  const verification = createEmailVerificationService({
    getRedis: () => redis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: { sendVerificationCode: async () => {} },
    randomIntFn: () => 123456
  })

  await verification.sendCode({
    email: 'user@example.com',
    purpose: 'register',
    ip: '127.0.0.1'
  })
  await assert.rejects(
    verification.sendCode({
      email: 'user@example.com',
      purpose: 'register',
      ip: '127.0.0.1'
    }),
    error => error.code === 'cooldown'
  )

  const limitedRedis = createRedisFake({ rateResults: [6] })
  const limited = createEmailVerificationService({
    getRedis: () => limitedRedis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: { sendVerificationCode: async () => {} }
  })
  await assert.rejects(
    limited.sendCode({
      email: 'other@example.com',
      purpose: 'register',
      ip: '127.0.0.1'
    }),
    error => error.code === 'rate_limited'
  )
})

test('delivery failure clears OTP state without exposing raw values', async () => {
  const redis = createRedisFake()
  const verification = createEmailVerificationService({
    getRedis: () => redis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: {
      sendVerificationCode: async () => {
        throw new Error('provider unavailable')
      }
    },
    randomIntFn: () => 654321
  })

  await assert.rejects(
    verification.sendCode({
      email: 'user@example.com',
      purpose: 'reset',
      ip: '127.0.0.1'
    }),
    error => error.code === 'delivery_failed'
  )
  const serialized = JSON.stringify(redis.calls)
  assert.match(serialized, /"del"/)
  assert.doesNotMatch(serialized, /user@example\.com|654321/)
})

test('consumeCode is single-use and invalidates after five failures', async () => {
  const singleUseRedis = createRedisFake({ consumeResults: [1, 0] })
  const singleUse = createEmailVerificationService({
    getRedis: () => singleUseRedis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: { sendVerificationCode: async () => {} }
  })
  const payload = {
    email: 'user@example.com',
    purpose: 'register',
    code: '123456'
  }

  assert.deepEqual(await singleUse.consumeCode(payload), { success: true })
  assert.deepEqual(await singleUse.consumeCode(payload), {
    success: false,
    message: '验证码无效或已过期'
  })

  const attemptsRedis = createRedisFake({
    consumeResults: [-1, -1, -1, -1, -2]
  })
  const attempts = createEmailVerificationService({
    getRedis: () => attemptsRedis,
    secret: 'test-secret-with-at-least-thirty-two-characters',
    mailer: { sendVerificationCode: async () => {} }
  })
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await attempts.consumeCode({
      email: 'user@example.com',
      purpose: 'reset',
      code: '000000'
    }), {
      success: false,
      message: '验证码无效或已过期'
    })
  }
})
~~~

- [ ] **Step 6: Run the verification-service tests**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/emailVerificationService.test.js
~~~

Expected: PASS for normalization, hashing, isolation, cooldown, limits, mail cleanup, attempt exhaustion, and single use.

- [ ] **Step 7: Commit Redis verification**

~~~powershell
git add server/src/services/emailVerificationService.js server/test/emailVerificationService.test.js
git commit -m "feat(auth): add Redis email verification security"
~~~

## Task 6: Add and mount the email-auth router

**Files:**

- Create: **server/src/routes/emailAuth.js**
- Create: **server/test/emailAuthRoute.test.js**
- Modify: **server/src/index.js**
- Modify: **server/test/indexRouteRegistration.test.js**
- Modify: **server/src/routes/auth.js**

- [ ] **Step 1: Write route-contract tests with injected dependencies**

Create server/test/emailAuthRoute.test.js with helpers that locate a route handler from router.stack and invoke it with fake req/res:

~~~js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmailAuthRouter } from '../src/routes/emailAuth.js'
import { EmailVerificationError } from '../src/services/emailVerificationService.js'

function handlerFor(router, method, path) {
  const layer = router.stack.find(item =>
    item.route?.path === path && item.route.methods[method]
  )
  return layer.route.stack[0].handle
}

async function invoke(handler, body, overrides = {}) {
  const result = { status: 200, body: null }
  const req = {
    body,
    ip: '127.0.0.1',
    deviceId: 'guest-device',
    ...overrides
  }
  const res = {
    status(code) { result.status = code; return this },
    json(bodyValue) { result.body = bodyValue; return this }
  }
  await handler(req, res)
  return result
}

function dependencies(overrides = {}) {
  return {
    accounts: {
      findByEmail: async () => undefined,
      createEmailAccount: async () => 42,
      completeLogin: async () => {},
      updatePassword: async () => {},
      ...overrides.accounts
    },
    verification: {
      sendCode: async () => ({ success: true }),
      consumeCode: async () => ({ success: true }),
      getLoginLock: async () => ({ count: 0, ttl: -1 }),
      recordLoginFailure: async () => {},
      clearSecurityState: async () => {},
      ...overrides.verification
    },
    hashPassword: async value => 'hash:' + value,
    comparePassword: async (value, hash) => hash === 'hash:' + value,
    sign: userId => 'token:' + userId,
    now: () => '2026-08-03 12:00:00',
    logger: { info() {}, warn() {}, error() {} }
  }
}

test('register requires a consumed register code before account creation', async () => {
  const router = createEmailAuthRouter(dependencies({
    verification: {
      consumeCode: async () => ({
        success: false,
        message: '验证码无效或已过期'
      })
    }
  }))
  const response = await invoke(
    handlerFor(router, 'post', '/register'),
    { email: 'user@example.com', code: '123456', password: 'secret' }
  )

  assert.equal(response.status, 400)
  assert.equal(response.body.success, false)
})

test('reset-code request has the same response for missing user and mail failure', async () => {
  const missingRouter = createEmailAuthRouter(dependencies())
  const failedRouter = createEmailAuthRouter(dependencies({
    accounts: {
      findByEmail: async () => ({
        id: 1,
        email_verified_at: '2026-08-03'
      })
    },
    verification: {
      sendCode: async () => { throw new Error('SMTP unavailable') }
    }
  }))
  const body = { email: 'user@example.com', purpose: 'reset' }

  const missing = await invoke(handlerFor(missingRouter, 'post', '/send-code'), body)
  const failed = await invoke(handlerFor(failedRouter, 'post', '/send-code'), body)

  assert.deepEqual(missing, failed)
  assert.equal(missing.status, 202)
})

test('register-code request sends mail and maps duplicate and cooldown responses', async () => {
  let sent
  const availableRouter = createEmailAuthRouter(dependencies({
    verification: {
      sendCode: async value => { sent = value }
    }
  }))
  const success = await invoke(
    handlerFor(availableRouter, 'post', '/send-code'),
    { email: 'User@Example.com', purpose: 'register' }
  )
  assert.equal(success.status, 200)
  assert.deepEqual(sent, {
    email: 'user@example.com',
    purpose: 'register',
    ip: '127.0.0.1'
  })

  const duplicateRouter = createEmailAuthRouter(dependencies({
    accounts: {
      findByEmail: async () => ({ id: 1 })
    }
  }))
  const duplicate = await invoke(
    handlerFor(duplicateRouter, 'post', '/send-code'),
    { email: 'user@example.com', purpose: 'register' }
  )
  assert.equal(duplicate.status, 409)

  const cooldownRouter = createEmailAuthRouter(dependencies({
    verification: {
      sendCode: async () => {
        throw new EmailVerificationError('cooldown', '请 60 秒后再试')
      }
    }
  }))
  const cooldown = await invoke(
    handlerFor(cooldownRouter, 'post', '/send-code'),
    { email: 'user@example.com', purpose: 'register' }
  )
  assert.equal(cooldown.status, 429)
})
~~~

Append the remaining contract tests:

~~~js
test('successful registration creates a verified account and returns JWT', async () => {
  let created
  const router = createEmailAuthRouter(dependencies({
    accounts: {
      createEmailAccount: async value => {
        created = value
        return 42
      }
    }
  }))
  const response = await invoke(
    handlerFor(router, 'post', '/register'),
    { email: 'User@Example.com', code: '123456', password: 'secret' }
  )

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    success: true,
    data: { token: 'token:42', userId: 42 }
  })
  assert.equal(created.email, 'user@example.com')
  assert.equal(created.passwordHash, 'hash:secret')
  assert.equal(created.deviceId, 'guest-device')
})

test('existing and concurrently inserted emails return 409', async () => {
  const existingRouter = createEmailAuthRouter(dependencies({
    accounts: {
      findByEmail: async () => ({ id: 1, email: 'user@example.com' })
    }
  }))
  const requestBody = {
    email: 'user@example.com',
    code: '123456',
    password: 'secret'
  }
  const existing = await invoke(
    handlerFor(existingRouter, 'post', '/register'),
    requestBody
  )

  const duplicateError = Object.assign(new Error('duplicate'), {
    code: 'ER_DUP_ENTRY'
  })
  const racingRouter = createEmailAuthRouter(dependencies({
    accounts: {
      createEmailAccount: async () => { throw duplicateError }
    }
  }))
  const racing = await invoke(
    handlerFor(racingRouter, 'post', '/register'),
    requestBody
  )

  assert.equal(existing.status, 409)
  assert.equal(racing.status, 409)
  assert.deepEqual(existing.body, racing.body)
})

test('unknown email and wrong password have identical login responses', async () => {
  const unknownRouter = createEmailAuthRouter(dependencies())
  const wrongRouter = createEmailAuthRouter(dependencies({
    accounts: {
      findByEmail: async () => ({
        id: 9,
        password: 'hash:correct',
        email_verified_at: '2026-08-03'
      })
    }
  }))
  const body = { email: 'user@example.com', password: 'wrong' }
  const unknown = await invoke(handlerFor(unknownRouter, 'post', '/login'), body)
  const wrong = await invoke(handlerFor(wrongRouter, 'post', '/login'), body)

  assert.equal(unknown.status, 401)
  assert.deepEqual(unknown, wrong)
})

test('five recorded login failures produce a 15-minute lock response', async () => {
  const router = createEmailAuthRouter(dependencies({
    verification: {
      getLoginLock: async () => ({ count: 5, ttl: 900 })
    }
  }))
  const response = await invoke(
    handlerFor(router, 'post', '/login'),
    { email: 'user@example.com', password: 'secret' }
  )

  assert.equal(response.status, 429)
  assert.match(response.body.error, /15 分钟/)
})

test('successful login clears locks, migrates guest data, and returns JWT', async () => {
  let completed
  let cleared = false
  const router = createEmailAuthRouter(dependencies({
    accounts: {
      findByEmail: async () => ({
        id: 9,
        password: 'hash:secret',
        email_verified_at: '2026-08-03'
      }),
      completeLogin: async (userId, deviceId) => {
        completed = [userId, deviceId]
      }
    },
    verification: {
      clearSecurityState: async () => { cleared = true }
    }
  }))
  const response = await invoke(
    handlerFor(router, 'post', '/login'),
    { email: 'user@example.com', password: 'secret' }
  )

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    success: true,
    data: { token: 'token:9', userId: 9 }
  })
  assert.deepEqual(completed, [9, 'guest-device'])
  assert.equal(cleared, true)
})

test('successful reset hashes the new password and clears security state', async () => {
  let updated
  let cleared = false
  const router = createEmailAuthRouter(dependencies({
    accounts: {
      findByEmail: async () => ({
        id: 7,
        email_verified_at: '2026-08-03'
      }),
      updatePassword: async (userId, passwordHash) => {
        updated = [userId, passwordHash]
      }
    },
    verification: {
      clearSecurityState: async () => { cleared = true }
    }
  }))
  const response = await invoke(
    handlerFor(router, 'post', '/reset-password'),
    { email: 'user@example.com', code: '123456', password: 'new-secret' }
  )

  assert.equal(response.status, 200)
  assert.deepEqual(updated, [7, 'hash:new-secret'])
  assert.equal(cleared, true)
})
~~~

- [ ] **Step 2: Run route tests and confirm failure**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/emailAuthRoute.test.js
~~~

Expected: FAIL because emailAuth.js is absent.

- [ ] **Step 3: Implement the router factory**

Create server/src/routes/emailAuth.js. Use these imports and dependency contract:

~~~js
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import config from '../config.js'
import db from '../db.js'
import { getRedisClient } from '../redis.js'
import { signToken } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'
import { createSmtpEmailService } from '../services/emailService.js'
import {
  createEmailVerificationService,
  EmailVerificationError,
  isValidEmail,
  maskEmail,
  normalizeEmail
} from '../services/emailVerificationService.js'
import { createAuthAccountService } from '../services/authAccount.js'

const MAX_LOGIN_ATTEMPTS = 5
const RESET_ACCEPTED = {
  success: true,
  message: '如果该邮箱已注册，验证码将发送到你的邮箱'
}
~~~

Implement createEmailAuthRouter(deps) with four POST handlers:

~~~js
export function createEmailAuthRouter({
  accounts,
  verification,
  hashPassword,
  comparePassword,
  sign,
  now,
  logger
}) {
  const router = Router()

  const safe = (operation, handler) => async (req, res) => {
    try {
      return await handler(req, res)
    } catch (error) {
      logger.error(operation, {
        errorCode: error.code || 'unexpected_error'
      })
      return res.status(500).json({
        success: false,
        error: '服务暂时不可用，请稍后重试'
      })
    }
  }

  router.post('/send-code', safe('邮箱验证码请求失败', async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const purpose = req.body.purpose
    if (!isValidEmail(email) || !['register', 'reset'].includes(purpose)) {
      return res.status(400).json({ success: false, error: '邮箱或验证码用途不正确' })
    }

    const user = await accounts.findByEmail(email)
    if (purpose === 'reset') {
      if (user?.email_verified_at) {
        try {
          await verification.sendCode({ email, purpose, ip: req.ip })
        } catch (error) {
          logger.warn('找回密码邮件未发送', {
            email,
            reason: error.code || 'email_send_failed'
          })
        }
      }
      return res.status(202).json(RESET_ACCEPTED)
    }

    if (user) {
      return res.status(409).json({ success: false, error: '该邮箱已注册，请直接登录' })
    }
    try {
      await verification.sendCode({ email, purpose, ip: req.ip })
      return res.json({ success: true, message: '验证码已发送' })
    } catch (error) {
      const known = error instanceof EmailVerificationError
      const status = known && ['cooldown', 'rate_limited'].includes(error.code)
        ? 429
        : 503
      logger.warn('注册验证码邮件未发送', {
        email,
        reason: error.code || 'email_send_failed'
      })
      return res.status(status).json({
        success: false,
        error: known ? error.message : '邮件暂时无法发送，请稍后重试'
      })
    }
  }))

  router.post('/register', safe('邮箱注册请求失败', async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const password = String(req.body.password || '')
    if (!isValidEmail(email) || !/^\d{6}$/.test(String(req.body.code || '')) || password.length < 6) {
      return res.status(400).json({ success: false, error: '邮箱、验证码或密码格式不正确' })
    }
    if (await accounts.findByEmail(email)) {
      return res.status(409).json({ success: false, error: '该邮箱已注册，请直接登录' })
    }

    const verified = await verification.consumeCode({
      email,
      purpose: 'register',
      code: req.body.code
    })
    if (!verified.success) {
      return res.status(400).json({ success: false, error: verified.message })
    }

    try {
      const userId = await accounts.createEmailAccount({
        email,
        passwordHash: await hashPassword(password),
        nickname: maskEmail(email),
        verifiedAt: now(),
        deviceId: req.deviceId
      })
      logger.info('邮箱注册成功', { userId, email })
      return res.json({ success: true, data: { token: sign(userId), userId } })
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: '该邮箱已注册，请直接登录' })
      }
      logger.error('邮箱注册失败', {
        email,
        errorCode: error.code || 'database_error'
      })
      return res.status(500).json({ success: false, error: '注册失败，请稍后重试' })
    }
  }))

  router.post('/login', safe('邮箱登录请求失败', async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const password = String(req.body.password || '')
    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ success: false, error: '请输入正确的邮箱和密码' })
    }

    const lock = await verification.getLoginLock(email)
    if (lock.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ success: false, error: '登录尝试次数过多，请 15 分钟后重试' })
    }

    const user = await accounts.findByEmail(email)
    const accepted = user?.password && user?.email_verified_at
      ? await comparePassword(password, user.password)
      : false
    if (!accepted) {
      await verification.recordLoginFailure(email)
      return res.status(401).json({ success: false, error: '邮箱或密码错误' })
    }

    await verification.clearSecurityState(email)
    await accounts.completeLogin(user.id, req.deviceId)
    logger.info('邮箱登录成功', { userId: user.id, email })
    return res.json({ success: true, data: { token: sign(user.id), userId: user.id } })
  }))

  router.post('/reset-password', safe('邮箱重置密码请求失败', async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const password = String(req.body.password || '')
    if (!isValidEmail(email) || !/^\d{6}$/.test(String(req.body.code || '')) || password.length < 6) {
      return res.status(400).json({ success: false, error: '邮箱、验证码或密码格式不正确' })
    }
    const user = await accounts.findByEmail(email)
    if (!user?.email_verified_at) {
      return res.status(400).json({ success: false, error: '验证码无效或已过期' })
    }
    const verified = await verification.consumeCode({
      email,
      purpose: 'reset',
      code: req.body.code
    })
    if (!verified.success) {
      return res.status(400).json({ success: false, error: verified.message })
    }

    await accounts.updatePassword(user.id, await hashPassword(password))
    await verification.clearSecurityState(email)
    logger.info('邮箱密码重置成功', { userId: user.id, email })
    return res.json({ success: true, message: '密码重置成功，请使用新密码登录' })
  }))

  return router
}
~~~

Add the production dependency constructor at the end:

~~~js
export function createDefaultEmailAuthRouter() {
  const mailer = createSmtpEmailService(config.email)
  const verification = createEmailVerificationService({
    getRedis: getRedisClient,
    secret: config.auth.emailOtpSecret,
    mailer
  })
  return createEmailAuthRouter({
    accounts: createAuthAccountService(db),
    verification,
    hashPassword: password => bcrypt.hash(password, 10),
    comparePassword: bcrypt.compare,
    sign: signToken,
    now: () => db.fn.now(),
    logger: createLogger('EmailAuth')
  })
}
~~~

- [ ] **Step 4: Mount the router and expose verified email in /me**

In server/src/index.js:

~~~js
import { createDefaultEmailAuthRouter } from './routes/emailAuth.js'
~~~

After the existing auth mount:

~~~js
app.use('/api/auth', authRouter)
app.use('/api/auth/email', createDefaultEmailAuthRouter())
~~~

In server/src/routes/auth.js, change the /me select to:

~~~js
.select(
  'id',
  'username',
  'nickname',
  'phone',
  'email',
  'email_verified_at',
  'avatar'
)
~~~

Append these assertions to indexRouteRegistration.test.js:

~~~js
assert.match(source, /createDefaultEmailAuthRouter/)
assert.match(source, /app\.use\('\/api\/auth\/email', createDefaultEmailAuthRouter\(\)\)/)
~~~

- [ ] **Step 5: Run route and regression tests**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/emailAuthRoute.test.js test/indexRouteRegistration.test.js test/authAccount.test.js test/authMiddleware.test.js test/wechat.test.js test/smokeLocal.test.js
~~~

Expected: PASS; reset existence and SMTP failure responses are byte-for-byte equal.

- [ ] **Step 6: Commit the API**

~~~powershell
git add server/src/routes/emailAuth.js server/test/emailAuthRoute.test.js server/src/index.js server/test/indexRouteRegistration.test.js server/src/routes/auth.js
git commit -m "feat(auth): add verified email authentication API"
~~~

## Task 7: Add frontend API methods and pure form rules

**Files:**

- Create: **client/src/utils/authForm.js**
- Create: **client/test/authForm.test.js**
- Modify: **client/src/utils/api.js**

- [ ] **Step 1: Write pure frontend rule tests**

Create client/test/authForm.test.js:

~~~js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidAuthIdentity,
  purposeForMode,
  requestForAuthMode
} from '../src/utils/authForm.js'

test('identity validation follows the selected channel', () => {
  assert.equal(isValidAuthIdentity('email', ' User@Example.com '), true)
  assert.equal(isValidAuthIdentity('email', '13800138000'), false)
  assert.equal(isValidAuthIdentity('phone', '13800138000'), true)
})

test('registration and reset map to isolated code purposes', () => {
  assert.equal(purposeForMode('register'), 'register')
  assert.equal(purposeForMode('reset'), 'reset')
})

test('request selection preserves phone methods and uses email methods', () => {
  const calls = []
  const api = new Proxy({}, {
    get: (_target, name) => (...args) => calls.push([name, args])
  })

  requestForAuthMode(api, {
    channel: 'email',
    mode: 'login',
    identity: 'user@example.com',
    code: '',
    password: 'secret'
  })
  requestForAuthMode(api, {
    channel: 'phone',
    mode: 'register',
    identity: '13800138000',
    code: '123456',
    password: 'secret'
  })

  assert.deepEqual(calls, [
    ['emailLogin', ['user@example.com', 'secret']],
    ['register', ['13800138000', '123456', 'secret']]
  ])
})
~~~

- [ ] **Step 2: Run the test and confirm failure**

Run:

~~~powershell
Set-Location client
node --test test/authForm.test.js
~~~

Expected: FAIL because authForm.js is absent.

- [ ] **Step 3: Implement the pure form rules**

Create client/src/utils/authForm.js:

~~~js
export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function isValidAuthIdentity(channel, value) {
  if (channel === 'phone') return /^1[3-9]\d{9}$/.test(String(value || ''))
  const email = normalizeEmail(value)
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function purposeForMode(mode) {
  return mode === 'register' ? 'register' : 'reset'
}

export function requestForAuthMode(api, {
  channel,
  mode,
  identity,
  code,
  password
}) {
  if (channel === 'phone') {
    if (mode === 'login') return api.login(identity, password)
    if (mode === 'register') return api.register(identity, code, password)
    return api.resetPassword(identity, code, password)
  }

  const email = normalizeEmail(identity)
  if (mode === 'login') return api.emailLogin(email, password)
  if (mode === 'register') return api.emailRegister(email, code, password)
  return api.emailResetPassword(email, code, password)
}
~~~

- [ ] **Step 4: Add the four API client methods**

Add to the authentication section in client/src/utils/api.js:

~~~js
emailSendCode(email, purpose) {
  return request('/api/auth/email/send-code', {
    method: 'POST',
    body: JSON.stringify({ email, purpose })
  })
},

emailRegister(email, code, password) {
  return request('/api/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email, code, password })
  })
},

emailLogin(email, password) {
  return request('/api/auth/email/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  })
},

emailResetPassword(email, code, password) {
  return request('/api/auth/email/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, code, password })
  })
},
~~~

- [ ] **Step 5: Run the pure rules test and client build**

Run:

~~~powershell
Set-Location client
node --test test/authForm.test.js
npm run build
~~~

Expected: test PASS and Vite build completes successfully.

- [ ] **Step 6: Commit the client API boundary**

~~~powershell
git add client/src/utils/authForm.js client/test/authForm.test.js client/src/utils/api.js
git commit -m "feat(auth): add email auth client methods"
~~~

## Task 8: Upgrade the Vue login card

**Files:**

- Modify: **client/src/components/LoginPage.vue**
- Test: **client/test/authForm.test.js**

- [ ] **Step 1: Add the channel selector and dynamic identity field**

Place this selector above the existing login/register/reset tab bar:

~~~vue
<div class="channel-bar" aria-label="登录方式">
  <button
    type="button"
    :class="{ active: channel === 'email' }"
    @click="switchChannel('email')"
  >
    邮箱
  </button>
  <button
    type="button"
    :class="{ active: channel === 'phone' }"
    @click="switchChannel('phone')"
  >
    手机号
  </button>
</div>
~~~

Replace the fixed subtitle and phone field with:

~~~vue
<p class="subtitle">
  {{ channel === 'email' ? '邮箱登录，安全管理财务' : '手机号登录，轻松管理财务' }}
</p>

<div class="field">
  <label>{{ channel === 'email' ? '邮箱' : '手机号' }}</label>
  <input
    v-model="identity"
    :type="channel === 'email' ? 'email' : 'tel'"
    :placeholder="channel === 'email' ? '请输入邮箱' : '请输入手机号'"
    :maxlength="channel === 'email' ? 254 : 11"
    :autocomplete="channel === 'email' ? 'email' : 'tel'"
    required
  />
</div>
~~~

Replace the complete verification-code field with:

~~~vue
<div class="field" v-if="mode !== 'login'">
  <label>验证码</label>
  <div class="code-row">
    <input
      v-model="code"
      type="text"
      inputmode="numeric"
      placeholder="6位验证码"
      maxlength="6"
      autocomplete="one-time-code"
      required
    />
    <button
      type="button"
      class="btn btn-code"
      :disabled="verificationCountdown > 0 || !identityValid || loading"
      @click="sendCode"
    >
      {{ verificationCountdown > 0 ? verificationCountdown + 's' : '发送验证码' }}
    </button>
  </div>
</div>
~~~

- [ ] **Step 2: Replace the script state and dispatch logic**

Change imports to:

~~~js
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app.js'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../utils/api.js'
import {
  isValidAuthIdentity,
  normalizeEmail,
  purposeForMode,
  requestForAuthMode
} from '../utils/authForm.js'
~~~

Use this state and computed logic:

~~~js
const channel = ref('email')
const mode = ref('login')
const identity = ref('')
const code = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')
const verificationCountdown = ref(0)
const isDev = ref(
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
)

let countdownTimer = null

const identityValid = computed(() =>
  isValidAuthIdentity(channel.value, identity.value)
)

const submitLabel = computed(() => {
  if (mode.value === 'login') return '🔐 登录'
  if (mode.value === 'register') return '📝 注册'
  return '🔑 重置密码'
})
~~~

Use these switch and cleanup functions:

~~~js
function clearSensitiveFields() {
  code.value = ''
  password.value = ''
  confirmPassword.value = ''
  error.value = ''
  success.value = ''
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer)
  countdownTimer = null
  verificationCountdown.value = 0
}

function switchMode(nextMode) {
  mode.value = nextMode
  clearSensitiveFields()
  stopCountdown()
}

function switchChannel(nextChannel) {
  channel.value = nextChannel
  identity.value = ''
  clearSensitiveFields()
  stopCountdown()
}
~~~

Replace sendCode with:

~~~js
async function sendCode() {
  if (!identityValid.value) {
    error.value = channel.value === 'email'
      ? '请输入正确的邮箱'
      : '请输入正确的手机号'
    return
  }
  error.value = ''
  try {
    const response = channel.value === 'email'
      ? await api.emailSendCode(
          normalizeEmail(identity.value),
          purposeForMode(mode.value)
        )
      : await api.sendCode(identity.value)
    if (!response.success) {
      error.value = response.error || '发送失败'
      return
    }
    success.value = response.message || '验证码已发送'
    verificationCountdown.value = 60
    countdownTimer = setInterval(() => {
      verificationCountdown.value -= 1
      if (verificationCountdown.value <= 0) stopCountdown()
    }, 1000)
  } catch (sendError) {
    error.value = sendError.message || '发送失败'
  }
}
~~~

Replace doSubmit with:

~~~js
async function doSubmit() {
  error.value = ''
  success.value = ''

  if (!identityValid.value) {
    error.value = channel.value === 'email'
      ? '请输入正确的邮箱'
      : '请输入正确的手机号'
    return
  }
  if (!password.value || password.value.length < 6) {
    error.value = '密码至少6位'
    return
  }
  if (mode.value !== 'login') {
    if (!/^\d{6}$/.test(code.value)) {
      error.value = '请输入6位验证码'
      return
    }
    if (password.value !== confirmPassword.value) {
      error.value = '两次密码不一致'
      return
    }
  }

  loading.value = true
  try {
    const response = await requestForAuthMode(api, {
      channel: channel.value,
      mode: mode.value,
      identity: identity.value,
      code: code.value,
      password: password.value
    })

    if (!response.success) {
      error.value = response.error || '操作失败'
      return
    }
    if (mode.value === 'reset') {
      mode.value = 'login'
      code.value = ''
      password.value = ''
      confirmPassword.value = ''
      success.value = '密码重置成功，请使用新密码登录'
      return
    }

    store.setToken(response.data.token)
    await store.loadUser()
    router.push('/')
  } catch (submitError) {
    error.value = submitError.message || '网络错误'
  } finally {
    loading.value = false
  }
}
~~~

Update showWechatTip to:

~~~js
function showWechatTip() {
  error.value = '微信小程序登录需在微信内打开小程序使用。Web 端请使用邮箱或手机号登录。'
}
~~~

Add lifecycle cleanup:

~~~js
onUnmounted(stopCountdown)
~~~

- [ ] **Step 3: Add channel styles without changing the page theme**

Add:

~~~css
.channel-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.channel-bar button {
  padding: 9px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  color: #64748b;
  cursor: pointer;
}
.channel-bar button.active {
  border-color: #4f46e5;
  background: #eef2ff;
  color: #4f46e5;
  font-weight: 600;
}
~~~

Rename sms-row and btn-sms selectors in template and CSS to code-row and btn-code so the UI terminology matches both channels.

- [ ] **Step 4: Run frontend validation**

Run:

~~~powershell
Set-Location client
node --test test/authForm.test.js
npm run build
~~~

Expected: test PASS and build PASS without Vue template errors.

- [ ] **Step 5: Manually verify form-state safety in the browser**

Run:

~~~powershell
npm --prefix client run dev
~~~

Verify:

1. Email is the initial channel.
2. Email and phone each expose login, register, and reset modes.
3. Switching channel or mode clears password and OTP.
4. Refreshing the page does not restore password or OTP.
5. Countdown stops when leaving the component.

- [ ] **Step 6: Commit the login UI**

~~~powershell
git add client/src/components/LoginPage.vue
git commit -m "feat(auth): add email login experience"
~~~

## Task 9: Document, integrate, and verify the complete flow

**Files:**

- Modify: **README.md**
- Verify: all files changed in Tasks 1-8

- [ ] **Step 1: Document login modes and personal SMTP setup**

Add a concise README authentication section containing:

~~~markdown
### 认证方式

- 邮箱 + 密码：注册和找回密码均使用 6 位邮件验证码。
- 手机号 + 密码：保留现有接口；生产短信供应商尚未接入。
- 微信：保留现有小程序和公众号入口。

个人邮箱发送验证码时，SMTP_PASS 必须填写邮箱服务商生成的 SMTP
授权码，不是邮箱登录密码，也不是用户收到的 6 位验证码。生产环境还
必须设置独立的 EMAIL_OTP_SECRET；真实邮箱、授权码和密钥不得提交到
Git 仓库。
~~~

- [ ] **Step 2: Run all targeted backend tests**

Run:

~~~powershell
Set-Location server
node --test --test-force-exit test/config.test.js test/schema.test.js test/authAccount.test.js test/emailService.test.js test/emailVerificationService.test.js test/emailAuthRoute.test.js test/logger.test.js test/indexRouteRegistration.test.js test/authMiddleware.test.js test/wechat.test.js test/smokeLocal.test.js
~~~

Expected: all listed tests PASS.

- [ ] **Step 3: Run frontend tests and production build**

Run:

~~~powershell
Set-Location client
node --test test/authForm.test.js
npm run build
~~~

Expected: PASS and dist assets are emitted.

- [ ] **Step 4: Run the full backend suite against the recorded baseline**

Run:

~~~powershell
Set-Location server
npm test
~~~

Expected: no email-auth, phone-auth, schema, config, logger, or route-registration failure. The overall failure count must not exceed the pre-implementation baseline of 16 known unrelated failures; capture the names of any remaining failures in the handoff.

- [ ] **Step 5: Build the production backend image**

Run from the repository root:

~~~powershell
docker build -t smart-finance-email-auth:verify ./server
docker run --rm --entrypoint node smart-finance-email-auth:verify -e "import('nodemailer').then(() => console.log('nodemailer ok'))"
~~~

Expected: image build succeeds and prints nodemailer ok.

- [ ] **Step 6: Perform a real SMTP smoke test without exposing credentials**

Set secrets only in the current shell, start the stack, and request a registration code:

~~~powershell
$env:SMTP_HOST = Read-Host 'SMTP host'
$env:SMTP_PORT = '465'
$env:SMTP_SECURE = 'true'
$env:SMTP_USER = Read-Host 'Sender email'
$env:SMTP_PASS = Read-Host 'SMTP authorization code'
$env:MAIL_FROM = 'Smart Finance <' + $env:SMTP_USER + '>'
$env:EMAIL_OTP_SECRET = Read-Host 'Independent 32+ character OTP secret'
$env:JWT_SECRET = Read-Host 'Existing 32+ character JWT secret'
$env:DB_PASSWORD = Read-Host 'Existing application database password'
$env:DB_ROOT_PASSWORD = Read-Host 'Existing database root password'
docker compose up -d --build
$recipient = Read-Host 'Recipient email'
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/email/send-code' -ContentType 'application/json' -Body (@{
  email = $recipient
  purpose = 'register'
} | ConvertTo-Json)
~~~

Read the code from the recipient inbox and complete registration:

~~~powershell
$otp = Read-Host '6-digit code received by email'
$password = Read-Host 'Test password'
$registered = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/email/register' -ContentType 'application/json' -Headers @{
  'X-Device-Id' = 'email-auth-smoke'
} -Body (@{
  email = $recipient
  code = $otp
  password = $password
} | ConvertTo-Json)
$registered.success
~~~

Expected: True.

Run the reset and login checks explicitly:

~~~powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/email/send-code' -ContentType 'application/json' -Body (@{
  email = $recipient
  purpose = 'reset'
} | ConvertTo-Json)
$resetOtp = Read-Host '6-digit reset code received by email'
$newPassword = Read-Host 'New test password'
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/email/reset-password' -ContentType 'application/json' -Body (@{
  email = $recipient
  code = $resetOtp
  password = $newPassword
} | ConvertTo-Json)

$oldPasswordRejected = $false
try {
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/email/login' -ContentType 'application/json' -Body (@{
    email = $recipient
    password = $password
  } | ConvertTo-Json)
} catch {
  $oldPasswordRejected = $_.Exception.Response.StatusCode.value__ -eq 401
}
if (-not $oldPasswordRejected) {
  throw 'Old password was not rejected'
}

$newLogin = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/email/login' -ContentType 'application/json' -Body (@{
  email = $recipient
  password = $newPassword
} | ConvertTo-Json)
if (-not $newLogin.success) {
  throw 'New password login failed'
}
~~~

Expected: reset succeeds, the old password returns 401, and the new password returns a JWT. Do not paste any secret or OTP into logs, commits, screenshots, or the final handoff.

- [ ] **Step 7: Inspect the final diff for scope and secrets**

Run:

~~~powershell
git status --short
git diff --check
git diff --stat
git grep -n -E "SMTP_PASS=|EMAIL_OTP_SECRET=" -- ':!server/.env.example' ':!docs/**'
~~~

Expected: diff check is clean; the secret scan has no output; changed files match the file map and contain no Agent/RAG/report refactors.

- [ ] **Step 8: Commit documentation and any final test-only corrections**

~~~powershell
git add README.md
git commit -m "docs(auth): document personal SMTP email login"
~~~

## Final acceptance checklist

- [ ] Existing /api/auth/register, /login, /send-code, /reset-password, WeChat, mock-login, bind-phone, and /me authentication middleware remain compatible.
- [ ] Email registration creates no user until the one-time register code is consumed.
- [ ] Email reset uses a separate one-time code and does not reveal account existence.
- [ ] OTPs and complete emails never appear in Redis keys or application logs; SMTP credentials remain environment-only.
- [ ] New and existing MySQL databases both start successfully with the email schema.
- [ ] Email login enforces five failures and a 15-minute lock.
- [ ] Phone and email flows both work from the Vue login page.
- [ ] Targeted tests and client build pass; full-suite failures do not exceed the recorded unrelated baseline.
