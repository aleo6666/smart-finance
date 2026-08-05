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
  if (channel === 'email-quick') return isValidEmail(value)
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
  if (!['email', 'email-quick'].includes(channel)) {
    throw new Error('Unsupported auth channel')
  }
  if (!['login', 'register'].includes(mode)) {
    throw new Error('Unsupported auth mode')
  }

  const email = normalizeEmail(identity)
  
  if (channel === 'email-quick' || channel === 'email') {
    if (mode === 'login') return api.emailLogin(email, password)
    if (mode === 'register') return api.emailQuickRegister(email, password)
  }

  throw new Error('Unsupported auth mode for this channel')
}
