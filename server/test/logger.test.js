import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../src/utils/logger.js'

function captureError(extra) {
  const originalError = console.error
  const output = []
  console.error = (...args) => output.push(args.join(' '))
  try {
    createLogger('Email').error('delivery failed', extra)
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

test('logger handles short email local parts and malformed email values without throwing', () => {
  assert.match(captureError({ email: 'a@example.com' }), /email=a\*\*\*@example\.com/)
  assert.match(captureError({ email: 'ab@example.com' }), /email=a\*\*\*b@example\.com/)

  const malformed = captureError({ email: 'not-an-email' })
  assert.equal(malformed.includes('not-an-email'), false)
  assert.doesNotThrow(() => captureError({ email: null }))
})
