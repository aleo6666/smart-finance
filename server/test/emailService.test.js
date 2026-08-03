import test from 'node:test'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import {
  createEmailService,
  createSmtpEmailService
} from '../src/services/emailService.js'

function createTransport() {
  const messages = []
  return {
    messages,
    async sendMail(message) {
      messages.push(message)
      return { messageId: 'message-1' }
    }
  }
}

function assertSafeVerificationContent(content, code, recipient) {
  assert.match(content, new RegExp(code))
  assert.match(content, /5\s*分钟/)
  assert.match(content, /请勿.*泄露/)
  assert.equal(content.includes(recipient), false)
}

test('sendVerificationCode sends one registration email with fixed safe content', async () => {
  const transport = createTransport()
  const service = createEmailService({
    transport,
    from: 'Smart Finance <sender@example.com>'
  })

  const result = await service.sendVerificationCode({
    to: 'user@example.com',
    code: '123456',
    purpose: 'register'
  })

  assert.deepEqual(result, { messageId: 'message-1' })
  assert.equal(transport.messages.length, 1)
  const message = transport.messages[0]
  assert.equal(message.from, 'Smart Finance <sender@example.com>')
  assert.equal(message.to, 'user@example.com')
  assert.match(message.subject, /注册验证码/)
  assertSafeVerificationContent(message.text, '123456', 'user@example.com')
  assertSafeVerificationContent(message.html, '123456', 'user@example.com')
})

test('sendVerificationCode uses the reset password subject', async () => {
  const transport = createTransport()
  const service = createEmailService({ transport, from: 'sender@example.com' })

  await service.sendVerificationCode({
    to: 'user@example.com',
    code: '654321',
    purpose: 'reset'
  })

  assert.match(transport.messages[0].subject, /重置密码验证码/)
})

test('sendVerificationCode rejects unsupported purposes before sending', async () => {
  const transport = createTransport()
  const service = createEmailService({ transport, from: 'sender@example.com' })

  await assert.rejects(
    service.sendVerificationCode({
      to: 'user@example.com',
      code: '123456',
      purpose: 'login'
    }),
    /Unsupported verification purpose/
  )
  assert.equal(transport.messages.length, 0)
})

test('sendVerificationCode propagates transport failures unchanged', async () => {
  const transportError = new Error('SMTP unavailable')
  const service = createEmailService({
    transport: {
      sendMail() {
        return Promise.reject(transportError)
      }
    },
    from: 'sender@example.com'
  })

  await assert.rejects(
    service.sendVerificationCode({
      to: 'user@example.com',
      code: '123456',
      purpose: 'register'
    }),
    error => error === transportError
  )
})

test('createSmtpEmailService configures nodemailer and uses the configured sender', async t => {
  const originalCreateTransport = nodemailer.createTransport
  const transport = createTransport()
  let transportOptions
  nodemailer.createTransport = options => {
    transportOptions = options
    return transport
  }
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport
  })

  const service = createSmtpEmailService({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'smtp-user',
    pass: 'smtp-password',
    from: 'sender@example.com'
  })
  await service.sendVerificationCode({
    to: 'user@example.com',
    code: '123456',
    purpose: 'register'
  })

  assert.deepEqual(transportOptions, {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    auth: { user: 'smtp-user', pass: 'smtp-password' }
  })
  assert.equal(transport.messages[0].from, 'sender@example.com')
})
