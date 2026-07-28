import { randomUUID } from 'node:crypto'
import config from '../../config.js'
import { agentRedisCache } from '../../redis.js'
import {
  normalizeTrustedUserId
} from '../runtime.js'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DATASET_REF_PATTERN = /^ds_[A-Za-z0-9-]{1,128}$/
const SCOPE_FIELDS = new Set([
  'month',
  'startDate',
  'endDate',
  'category',
  'type',
  'queryKind'
])

export class DatasetValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DatasetValidationError'
    this.code = 'INVALID_DATASET'
    this.statusCode = 400
    this.expose = true
  }
}

export class DatasetScopeMismatchError extends Error {
  constructor() {
    super('dataset unavailable')
    this.name = 'DatasetScopeMismatchError'
    this.code = 'DATASET_SCOPE_MISMATCH'
    this.statusCode = 403
    this.expose = true
  }
}

export class DatasetStoreUnavailableError extends Error {
  constructor() {
    super('temporary dataset store unavailable')
    this.name = 'DatasetStoreUnavailableError'
    this.code = 'DATASET_STORE_UNAVAILABLE'
    this.statusCode = 503
    this.expose = true
  }
}

function validateString(value, fieldName, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new DatasetValidationError(`${fieldName} is invalid`)
  }
  return value
}

function visitJson(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('not JSON-safe')
    return
  }
  if (typeof value !== 'object' || seen.has(value)) throw new Error('not JSON-safe')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('not JSON-safe')
  }
  seen.add(value)
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visitJson(child, seen)
  }
  seen.delete(value)
}

function validateJson(value, fieldName) {
  if (value === undefined) return undefined
  let serialized
  try {
    visitJson(value, new Set())
    serialized = JSON.stringify(value)
  } catch {
    throw new DatasetValidationError(`${fieldName} must be JSON-safe`)
  }
  if (serialized === undefined) {
    throw new DatasetValidationError(`${fieldName} must be JSON-safe`)
  }
  return serialized
}

function normalizeScope(scope) {
  if (scope === undefined) return {}
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new DatasetValidationError('scope is invalid')
  }
  const normalized = {}
  for (const [field, value] of Object.entries(scope)) {
    if (!SCOPE_FIELDS.has(field) || typeof value !== 'string' || value.length > 64) {
      throw new DatasetValidationError('scope is invalid')
    }
    normalized[field] = value
  }
  return normalized
}

function buildKey({ userId, requestId, datasetRef }) {
  return `agent:dataset:${userId}:${requestId}:${datasetRef}`
}

export function createDatasetStore({
  cache = agentRedisCache,
  ttlSeconds = config.agent.datasetTtlSeconds,
  randomId = randomUUID,
  maxRows = 1000,
  maxBytes = 1024 * 1024
} = {}) {
  if (!cache || typeof cache.set !== 'function' || typeof cache.get !== 'function') {
    throw new TypeError('cache must provide set and get')
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('ttlSeconds must be a positive integer')
  }

  function scopeKey(input) {
    return {
      userId: normalizeTrustedUserId(input.userId),
      requestId: validateString(input.requestId, 'requestId', REQUEST_ID_PATTERN),
      datasetRef: validateString(input.datasetRef, 'datasetRef', DATASET_REF_PATTERN)
    }
  }

  return {
    async put({
      userId,
      requestId,
      rows = [],
      summary = null,
      scope = {}
    }) {
      const trustedUserId = normalizeTrustedUserId(userId)
      const trustedRequestId = validateString(requestId, 'requestId', REQUEST_ID_PATTERN)
      if (!Array.isArray(rows) || rows.length > maxRows) {
        throw new DatasetValidationError('rows exceed limit')
      }
      const trustedScope = normalizeScope(scope)
      const datasetRef = `ds_${String(randomId())}`
      validateString(datasetRef, 'datasetRef', DATASET_REF_PATTERN)
      const payload = { rows, summary, scope: trustedScope }
      const serialized = validateJson(payload, 'dataset')
      if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
        throw new DatasetValidationError('dataset exceeds byte limit')
      }
      try {
        await cache.set(buildKey({
          userId: trustedUserId,
          requestId: trustedRequestId,
          datasetRef
        }), payload, ttlSeconds)
      } catch {
        throw new DatasetStoreUnavailableError()
      }
      return {
        datasetRef,
        count: rows.length,
        scope: trustedScope
      }
    },

    async get(input) {
      let exact
      try {
        exact = scopeKey(input)
      } catch (error) {
        if (error instanceof DatasetValidationError) {
          throw new DatasetScopeMismatchError()
        }
        throw error
      }
      let value
      try {
        value = await cache.get(buildKey(exact))
      } catch {
        throw new DatasetStoreUnavailableError()
      }
      if (!value) throw new DatasetScopeMismatchError()
      return value
    }
  }
}
