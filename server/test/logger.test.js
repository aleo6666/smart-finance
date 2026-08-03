import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../src/utils/logger.js'

function captureError(extra, {
  name = 'Email',
  message = 'delivery failed'
} = {}) {
  const originalError = console.error
  const output = []
  console.error = (...args) => output.push(args.join(' '))
  try {
    createLogger(name).error(message, extra)
  } finally {
    console.error = originalError
  }
  return output.join('\n')
}

test('logger masks complete email addresses while preserving the domain', () => {
  const output = captureError({ email: 'user@example.com' })

  assert.equal(output.includes('user@example.com'), false)
  assert.match(output, /email=u\*\*\*r@example\.com/)
})

test('logger redacts authentication secrets but preserves operational errorCode', () => {
  const output = captureError({
    smtpPass: 'smtp-pass-value',
    password: 'account-password',
    token: 'token-value',
    otp: '123456',
    code: '654321',
    verificationCode: '998877',
    errorCode: 'ER_SMTP_FAILURE',
    passage: 'keep-visible'
  })

  for (const secret of [
    'smtp-pass-value',
    'account-password',
    'token-value',
    '123456',
    '654321',
    '998877'
  ]) {
    assert.equal(output.includes(secret), false)
  }
  assert.match(output, /errorCode=ER_SMTP_FAILURE/)
  assert.match(output, /passage=keep-visible/)
})

test('logger redacts explicit password keys without matching unrelated key fragments', () => {
  const output = captureError({
    pass: 'canonical-pass',
    smtp_pass: 'underscore-pass',
    'smtp-pass': 'hyphen-pass',
    smtpPass: 'camel-pass',
    tokenCount: 7,
    keyboardLayout: 'qwerty',
    passage: 'keep-visible',
    errorCode: 'ER_SMTP_FAILURE'
  })

  for (const secret of [
    'canonical-pass',
    'underscore-pass',
    'hyphen-pass',
    'camel-pass'
  ]) {
    assert.equal(output.includes(secret), false)
  }
  assert.match(output, /tokenCount=7/)
  assert.match(output, /keyboardLayout=qwerty/)
  assert.match(output, /passage=keep-visible/)
  assert.match(output, /errorCode=ER_SMTP_FAILURE/)
})

test('logger recursively sanitizes objects and arrays', () => {
  const output = captureError({
    nested: {
      email: 'user@example.com',
      code: '123456',
      smtp: { pass: 'app-code' }
    },
    array: ['user@example.com', '123456', { password: 'pw' }]
  })

  for (const secret of ['user@example.com', '123456', 'app-code', '"pw"']) {
    assert.equal(output.includes(secret), false)
  }
  assert.match(output, /nested=\{"email":"u\*\*\*r@example\.com","code":"\*\*\*REDACTED\*\*\*","smtp":\{"pass":"\*\*\*REDACTED\*\*\*"\}\}/)
  assert.match(output, /array=\["u\*\*\*r@example\.com","\*\*\*REDACTED\*\*\*",\{"password":"\*\*\*REDACTED\*\*\*"\}\]/)
})

test('logger marks circular references without throwing', () => {
  const circular = { status: 'retrying' }
  circular.self = circular

  let output
  assert.doesNotThrow(() => {
    output = captureError({ nested: circular })
  })
  assert.match(output, /nested=\{"status":"retrying","self":"\[Circular\]"\}/)
})

test('logger neutralizes control characters and malformed email injection values', () => {
  const output = captureError({
    'header\r\nFORGED_KEY': 'value\r\nFORGED_VALUE=1',
    email: 'user@example.com\r\nFORGED=1',
    alternate: 'first@second@example.com'
  }, {
    name: 'Email\r\nFORGED_MODULE=1',
    message: 'delivery failed\r\nFORGED_MESSAGE=1'
  })

  assert.equal(output.includes('\r'), false)
  assert.equal(output.includes('\n'), false)
  assert.equal(output.includes('user@example.com'), false)
  assert.equal(output.includes('first@second@example.com'), false)
})

test('logger handles short email local parts and malformed email values without throwing', () => {
  assert.match(captureError({ email: 'a@example.com' }), /email=a\*\*\*@example\.com/)
  assert.match(captureError({ email: 'ab@example.com' }), /email=a\*\*\*b@example\.com/)

  const malformed = captureError({ email: 'not-an-email' })
  assert.equal(malformed.includes('not-an-email'), false)
  assert.doesNotThrow(() => captureError({ email: null }))
})
