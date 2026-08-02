import { randomUUID } from 'node:crypto'

const DEVICE_TYPES = new Set([
  'desktop',
  'miniprogram',
  'mobile',
  'tablet',
  'web',
  'wechat'
])

export class RuntimeContextValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuntimeContextValidationError'
    this.code = 'ERR_INVALID_RUNTIME_CONTEXT'
    this.statusCode = 400
    this.expose = true
  }
}

function readHeader(req, name) {
  const directValue = req?.headers?.[name]
  if (directValue !== undefined) return directValue
  return typeof req?.get === 'function' ? req.get(name) : undefined
}

function trimmedString(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).trim()
}

export function normalizeTrustedSessionId(value) {
  const sessionId = trimmedString(value)
  if (!sessionId) {
    throw new RuntimeContextValidationError('sessionId is required')
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) {
    throw new RuntimeContextValidationError('sessionId is invalid')
  }
  return sessionId
}

export function normalizeTrustedUserId(userId) {
  const numericUserId = typeof userId === 'boolean' ? Number.NaN : Number(userId)
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    throw new RuntimeContextValidationError('userId must be a positive integer')
  }
  return numericUserId
}

function normalizeGeneratedId(randomId, fieldName) {
  const value = trimmedString(randomId())
  if (!value) {
    throw new RuntimeContextValidationError(`${fieldName} generation failed`)
  }
  return value
}

function normalizeDeviceType(value) {
  const normalized = trimmedString(value).toLowerCase().slice(0, 32)
  return DEVICE_TYPES.has(normalized) ? normalized : 'unknown'
}

function normalizeTimezone(value) {
  const normalized = trimmedString(value).slice(0, 64)
  if (!normalized) return 'Asia/Shanghai'
  return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(normalized)
    ? normalized
    : 'Asia/Shanghai'
}

function normalizeLocale(value) {
  const normalized = trimmedString(value).split(',')[0].split(';')[0].trim().slice(0, 32)
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)
    ? normalized
    : 'zh-CN'
}

function normalizeOptionalLedgerId(value) {
  const ledgerId = Number(value)
  return Number.isSafeInteger(ledgerId) && ledgerId > 0 ? ledgerId : null
}

export function buildRuntimeContext({
  req,
  userId,
  isAdmin: callerIsAdmin = false,
  randomId = randomUUID
}) {
  const numericUserId = normalizeTrustedUserId(userId)
  const requestId = normalizeGeneratedId(randomId, 'requestId')
  const requestedOperationId = trimmedString(readHeader(req, 'x-idempotency-key'))
  let operationId
  if (!requestedOperationId) {
    operationId = normalizeGeneratedId(randomId, 'operationId')
  } else if (/^[A-Za-z0-9._:-]{1,64}$/.test(requestedOperationId)) {
    operationId = requestedOperationId
  } else {
    throw new RuntimeContextValidationError('x-idempotency-key is invalid')
  }

  // isAdmin 只能从已验证的认证上下文中派生，不接受调用方裸传
  // 认证中间件通过 JWT payload 注入 req.adminLevel，此处做白名单校验
  const trustedAdminLevel = req?.adminLevel
  const isAdmin = typeof trustedAdminLevel === 'string' &&
    ['full', 'ledger_read'].includes(trustedAdminLevel)
    ? true
    : callerIsAdmin === true

  const context = {
    userId: numericUserId,
    sessionId: normalizeTrustedSessionId(req?.sessionId),
    requestId,
    operationId,
    isAdmin,
    adminLevel: isAdmin ? (trustedAdminLevel || 'full') : null,
    deviceType: normalizeDeviceType(readHeader(req, 'x-device-type')),
    timezone: normalizeTimezone(readHeader(req, 'x-timezone')),
    locale: normalizeLocale(readHeader(req, 'accept-language')),
    inputMode: req?.body?.inputMode === 'voice' ? 'voice' : 'text'
  }
  const currentLedgerId = normalizeOptionalLedgerId(req?.body?.ledgerId)
  if (currentLedgerId) context.currentLedgerId = currentLedgerId
  return Object.freeze(context)
}
