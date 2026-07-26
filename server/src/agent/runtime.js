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

function normalizeSessionId(req) {
  const candidates = [
    req?.body?.sessionId,
    readHeader(req, 'x-session-id'),
    req?.deviceId
  ]

  for (const candidate of candidates) {
    const sessionId = trimmedString(candidate)
    if (!sessionId) continue
    if (sessionId.length > 128) {
      throw new RuntimeContextValidationError('sessionId must not exceed 128 characters')
    }
    return sessionId
  }

  throw new RuntimeContextValidationError('sessionId is required')
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

export function buildRuntimeContext({
  req,
  userId,
  isAdmin,
  randomId = randomUUID
}) {
  const numericUserId = typeof userId === 'boolean' ? Number.NaN : Number(userId)
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    throw new RuntimeContextValidationError('userId must be a positive integer')
  }

  const requestId = normalizeGeneratedId(randomId, 'requestId')
  const requestedOperationId = trimmedString(readHeader(req, 'x-idempotency-key'))
  const operationId = requestedOperationId && requestedOperationId.length <= 64
    ? requestedOperationId
    : normalizeGeneratedId(randomId, 'operationId')

  return Object.freeze({
    userId: numericUserId,
    sessionId: normalizeSessionId(req),
    requestId,
    operationId,
    isAdmin: isAdmin === true,
    deviceType: normalizeDeviceType(readHeader(req, 'x-device-type')),
    timezone: normalizeTimezone(readHeader(req, 'x-timezone')),
    locale: normalizeLocale(readHeader(req, 'accept-language')),
    inputMode: req?.body?.inputMode === 'voice' ? 'voice' : 'text'
  })
}
