import { createHash } from 'node:crypto'
import { normalizeTrustedUserId } from '../runtime.js'

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_RESULT_BYTES = 64 * 1024

export class OperationValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OperationValidationError'
    this.code = 'INVALID_OPERATION'
    this.statusCode = 400
    this.expose = true
  }
}

export class OperationIdConflictError extends Error {
  constructor() {
    super('operation id conflicts with another input')
    this.name = 'OperationIdConflictError'
    this.code = 'OPERATION_ID_CONFLICT'
    this.statusCode = 409
    this.expose = true
  }
}

export class OperationStateConflictError extends Error {
  constructor() {
    super('operation state changed')
    this.name = 'OperationStateConflictError'
    this.code = 'OPERATION_STATE_CONFLICT'
    this.statusCode = 409
    this.expose = true
  }
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OperationValidationError('value must be JSON-safe')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new OperationValidationError('value must be JSON-safe')
  }
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new OperationValidationError('value must be JSON-safe')
  }
  seen.add(value)
  const serialized = Array.isArray(value)
    ? `[${value.map(item => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson(value[key], seen)}`
    ).join(',')}}`
  seen.delete(value)
  return serialized
}

function validateId(value, fieldName) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new OperationValidationError(`${fieldName} is invalid`)
  }
  return value
}

function parseResult(value) {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isMysqlDuplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062
}

export function hashOperation(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function createOperationStore(db) {
  if (typeof db !== 'function') throw new TypeError('db must be a Knex client')

  return {
    async claim({
      userId,
      operationId,
      operationType,
      input
    }) {
      const trustedUserId = normalizeTrustedUserId(userId)
      const trustedOperationId = validateId(operationId, 'operationId')
      const trustedOperationType = validateId(operationType, 'operationType')
      const inputHash = hashOperation({
        operationType: trustedOperationType,
        input
      })
      try {
        await db('agent_operations').insert({
          user_id: trustedUserId,
          operation_id: trustedOperationId,
          operation_type: trustedOperationType,
          status: 'started',
          input_hash: inputHash,
          result_json: null,
          error_code: null
        })
        return { status: 'owner', inputHash }
      } catch (error) {
        if (!isMysqlDuplicate(error)) throw error
      }

      const existing = await db('agent_operations')
        .where({
          user_id: trustedUserId,
          operation_id: trustedOperationId
        })
        .first()
      if (
        !existing ||
        existing.input_hash !== inputHash ||
        existing.operation_type !== trustedOperationType
      ) {
        throw new OperationIdConflictError()
      }
      if (existing.status === 'succeeded') {
        return {
          status: 'succeeded',
          result: parseResult(existing.result_json)
        }
      }
      if (existing.status === 'started') return { status: 'in_progress' }
      return {
        status: 'failed',
        errorCode: existing.error_code || 'OPERATION_FAILED'
      }
    },

    async succeed({
      userId,
      operationId,
      inputHash,
      result
    }) {
      const serialized = stableJson(result)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
        throw new OperationValidationError('operation result is too large')
      }
      const count = await db('agent_operations')
        .where({
          user_id: normalizeTrustedUserId(userId),
          operation_id: validateId(operationId, 'operationId'),
          input_hash: validateId(inputHash, 'inputHash'),
          status: 'started'
        })
        .update({
          status: 'succeeded',
          result_json: serialized,
          error_code: null
        })
      if (count !== 1) throw new OperationStateConflictError()
    },

    async fail({
      userId,
      operationId,
      inputHash,
      errorCode = 'OPERATION_FAILED'
    }) {
      const count = await db('agent_operations')
        .where({
          user_id: normalizeTrustedUserId(userId),
          operation_id: validateId(operationId, 'operationId'),
          input_hash: validateId(inputHash, 'inputHash'),
          status: 'started'
        })
        .update({
          status: 'failed',
          result_json: null,
          error_code: validateId(errorCode, 'errorCode')
        })
      if (count !== 1) throw new OperationStateConflictError()
    }
  }
}

