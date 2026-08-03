export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isValidEmail(value) {
  const email = normalizeEmail(value)
  if (!email || email.length > 254) return false

  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || local.length > 64 || !domain || domain.length > 253) return false
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false

  const labels = domain.split('.')
  return labels.length >= 2 && labels.every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  )
}

export function isValidAuthIdentity(channel, value) {
  if (channel === 'email') return isValidEmail(value)
  if (channel === 'phone') return typeof value === 'string' && /^1[3-9]\d{9}$/.test(value)
  return false
}

export function purposeForMode(mode) {
  if (mode === 'register') return 'register'
  if (mode === 'reset') return 'reset'
  return undefined
}

export function isValidAuthPassword(mode, value) {
  if (typeof value !== 'string' || !['login', 'register', 'reset'].includes(mode)) return false

  const minimumLength = mode === 'login' ? 1 : 6
  return value.length >= minimumLength && new TextEncoder().encode(value).length <= 72
}

export function requestForAuthMode(api, { channel, mode, identity, code, password }) {
  if (channel !== 'phone' && channel !== 'email') {
    throw new Error('Unsupported auth channel')
  }
  if (!['login', 'register', 'reset'].includes(mode)) {
    throw new Error('Unsupported auth mode')
  }

  const normalizedIdentity = channel === 'email' ? normalizeEmail(identity) : identity
  if (channel === 'phone') {
    if (mode === 'login') return api.login(normalizedIdentity, password)
    if (mode === 'register') return api.register(normalizedIdentity, code, password)
    return api.resetPassword(normalizedIdentity, code, password)
  }

  if (mode === 'login') return api.emailLogin(normalizedIdentity, password)
  if (mode === 'register') return api.emailRegister(normalizedIdentity, code, password)
  return api.emailResetPassword(normalizedIdentity, code, password)
}
