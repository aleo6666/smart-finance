import nodemailer from 'nodemailer'

const PURPOSE_LABEL = Object.freeze({
  register: '注册',
  reset: '重置密码'
})

export function createEmailService({ transport, from }) {
  return {
    async sendVerificationCode({ to, code, purpose }) {
      if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSE_LABEL, purpose)) {
        throw new Error('Unsupported verification purpose')
      }
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        throw new Error('Invalid verification code')
      }

      const label = PURPOSE_LABEL[purpose]
      return transport.sendMail({
        from,
        to,
        subject: `Smart Finance ${label}验证码`,
        text: `您的${label}验证码是：${code}\n验证码将在 5 分钟后失效。请勿向任何人泄露此验证码。`,
        html: `<p>您的${label}验证码是：<strong>${code}</strong></p><p>验证码将在 5 分钟后失效。请勿向任何人泄露此验证码。</p>`
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
