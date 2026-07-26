import {
  normalizeTrustedSessionId,
  normalizeTrustedUserId
} from '../runtime.js'

const NORMAL_KEYS = new Set([
  'preferences.default_currency',
  'preferences.response_style',
  'preferences.preferred_categories',
  'preferences.disabled_categories'
])
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const KEY_PATTERN = /^[a-z0-9_]{1,64}$/
const OPERATION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_VALUE_BYTES = 8192
const MAX_VALUE_DEPTH = 8

export class MemoryValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MemoryValidationError'
    this.code = 'INVALID_MEMORY'
    this.statusCode = 400
    this.expose = true
  }
}

export class MemoryVersionConflictError extends Error {
  constructor() {
    super('memory version conflict')
    this.name = 'MemoryVersionConflictError'
    this.code = 'MEMORY_VERSION_CONFLICT'
    this.statusCode = 409
    this.expose = true
  }
}

export class MemoryAlreadyExistsError extends Error {
  constructor() {
    super('memory already exists')
    this.name = 'MemoryAlreadyExistsError'
    this.code = 'MEMORY_ALREADY_EXISTS'
    this.statusCode = 409
    this.expose = true
  }
}

function validateName(value, fieldName, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new MemoryValidationError(`${fieldName} is invalid`)
  }
  return value
}

function validateOperationId(value) {
  return validateName(value, 'operationId', OPERATION_PATTERN)
}

function validateExpectedVersion(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MemoryValidationError('expectedVersion must be a positive integer')
  }
  return value
}

function visitJson(value, depth, seen) {
  if (depth > MAX_VALUE_DEPTH) {
    throw new MemoryValidationError('memory value exceeds maximum depth')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MemoryValidationError('memory value must be JSON-safe')
    return
  }
  if (typeof value !== 'object') {
    throw new MemoryValidationError('memory value must be JSON-safe')
  }
  if (seen.has(value)) throw new MemoryValidationError('memory value must be JSON-safe')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new MemoryValidationError('memory value must be JSON-safe')
  }
  seen.add(value)
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visitJson(child, depth + 1, seen)
  }
  seen.delete(value)
}

function serializeValue(value) {
  visitJson(value, 0, new Set())
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new MemoryValidationError('memory value must be JSON-safe')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
    throw new MemoryValidationError('memory value is too large')
  }
  return serialized
}

function validateExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new MemoryValidationError('expiresAt is invalid')
  }
  return date
}

function parseJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toMemory(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    namespace: row.namespace,
    memoryKey: row.memory_key,
    value: parseJson(row.value_json),
    sensitivity: row.sensitivity,
    status: row.status,
    sourceType: row.source_type,
    sourceSessionId: row.source_session_id ?? null,
    version: row.version,
    confirmedAt: row.confirmed_at ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function scope({ userId, namespace, memoryKey }) {
  return {
    userId: normalizeTrustedUserId(userId),
    namespace: validateName(namespace, 'namespace', NAME_PATTERN),
    memoryKey: validateName(memoryKey, 'memoryKey', KEY_PATTERN)
  }
}

function validateSessionIfPresent(value) {
  return value === undefined ? undefined : normalizeTrustedSessionId(value)
}

function isExpired(row, now) {
  return row.expires_at != null && new Date(row.expires_at).getTime() <= now.getTime()
}

function whereNotExpired(query, client) {
  return query.where(expiry =>
    expiry
      .whereNull('expires_at')
      .orWhere('expires_at', '>', client.fn.now())
  )
}

function isMysqlDuplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062
}

function auditSnapshot(memory) {
  if (!memory) return null
  return JSON.stringify({
    namespace: memory.namespace,
    memoryKey: memory.memoryKey,
    sensitivity: memory.sensitivity,
    status: memory.status,
    version: memory.version,
    value: '[REDACTED]'
  })
}

async function insertAudit(trx, {
  userId,
  namespace,
  memoryKey,
  action,
  before,
  after,
  operationId
}) {
  await trx('memory_audit_logs').insert({
    user_id: userId,
    namespace,
    memory_key: memoryKey,
    action,
    before_json: auditSnapshot(before),
    after_json: auditSnapshot(after),
    operation_id: operationId
  })
}

export function classifyMemory(namespace, memoryKey) {
  return NORMAL_KEYS.has(`${namespace}.${memoryKey}`) ? 'normal' : 'sensitive'
}

export function createUserMemoryRepository(db, { now = () => new Date() } = {}) {
  if (typeof db !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('db must be a Knex client')
  }

  async function findExact(client, exact, extra = {}) {
    return client('user_memories')
      .where({
        user_id: exact.userId,
        namespace: exact.namespace,
        memory_key: exact.memoryKey,
        ...extra
      })
      .forUpdate()
      .first()
  }

  return {
    async listActive(userId) {
      const trustedUserId = normalizeTrustedUserId(userId)
      const rows = await whereNotExpired(
        db('user_memories').where({
          user_id: trustedUserId,
          status: 'active'
        }),
        db
      ).select()
      return rows
        .filter(row => !isExpired(row, now()))
        .map(toMemory)
    },

    async get(userId, namespace, memoryKey) {
      const exact = scope({ userId, namespace, memoryKey })
      const row = await whereNotExpired(
        db('user_memories').where({
          user_id: exact.userId,
          namespace: exact.namespace,
          memory_key: exact.memoryKey
        }),
        db
      ).first()
      if (!row || row.status === 'deleted' || isExpired(row, now())) return null
      return toMemory(row)
    },

    async propose(input) {
      const exact = scope(input)
      const operationId = validateOperationId(input.operationId)
      const sessionId = normalizeTrustedSessionId(input.sessionId)
      const valueJson = serializeValue(input.value)
      const sensitivity = classifyMemory(exact.namespace, exact.memoryKey)
      const status = sensitivity === 'normal' ? 'active' : 'pending'
      const expiresAt = validateExpiresAt(input.expiresAt)

      return db.transaction(async trx => {
        if (await findExact(trx, exact)) throw new MemoryAlreadyExistsError()
        const row = {
          user_id: exact.userId,
          namespace: exact.namespace,
          memory_key: exact.memoryKey,
          value_json: valueJson,
          sensitivity,
          status,
          source_type: 'explicit',
          source_session_id: sessionId,
          version: 1,
          confirmed_at: null,
          expires_at: expiresAt
        }
        let inserted
        try {
          inserted = await trx('user_memories').insert(row)
        } catch (error) {
          if (isMysqlDuplicate(error)) throw new MemoryAlreadyExistsError()
          throw error
        }
        const after = toMemory({ id: inserted?.[0], ...row })
        await insertAudit(trx, {
          ...exact,
          action: 'propose',
          before: null,
          after,
          operationId
        })
        return after
      })
    },

    async update(input) {
      const exact = scope(input)
      const expectedVersion = validateExpectedVersion(input.expectedVersion)
      const operationId = validateOperationId(input.operationId)
      const sessionId = normalizeTrustedSessionId(input.sessionId)
      const valueJson = serializeValue(input.value)
      const sensitivity = classifyMemory(exact.namespace, exact.memoryKey)
      const status = sensitivity === 'normal' ? 'active' : 'pending'
      const expiresAt = validateExpiresAt(input.expiresAt)

      return db.transaction(async trx => {
        const row = await findExact(trx, exact, { version: expectedVersion })
        if (!row || row.status === 'deleted') throw new MemoryVersionConflictError()
        const before = toMemory(row)
        const changes = {
          value_json: valueJson,
          sensitivity,
          status,
          source_type: 'explicit',
          source_session_id: sessionId,
          version: expectedVersion + 1,
          confirmed_at: null,
          expires_at: expiresAt
        }
        const count = await trx('user_memories')
          .where({
            user_id: exact.userId,
            namespace: exact.namespace,
            memory_key: exact.memoryKey,
            version: expectedVersion
          })
          .update(changes)
        if (count !== 1) throw new MemoryVersionConflictError()
        const after = toMemory({ ...row, ...changes })
        await insertAudit(trx, {
          ...exact,
          action: 'update',
          before,
          after,
          operationId
        })
        return after
      })
    },

    async confirm(input) {
      const exact = scope(input)
      const expectedVersion = validateExpectedVersion(input.expectedVersion)
      const operationId = validateOperationId(input.operationId)
      validateSessionIfPresent(input.sessionId)

      return db.transaction(async trx => {
        const row = await findExact(trx, exact, {
          version: expectedVersion,
          status: 'pending'
        })
        if (!row) throw new MemoryVersionConflictError()
        const before = toMemory(row)
        const changes = {
          status: 'active',
          source_type: 'confirmed',
          version: expectedVersion + 1,
          confirmed_at: now()
        }
        const count = await trx('user_memories')
          .where({
            user_id: exact.userId,
            namespace: exact.namespace,
            memory_key: exact.memoryKey,
            version: expectedVersion,
            status: 'pending'
          })
          .update(changes)
        if (count !== 1) throw new MemoryVersionConflictError()
        const after = toMemory({ ...row, ...changes })
        await insertAudit(trx, {
          ...exact,
          action: 'confirm',
          before,
          after,
          operationId
        })
        return after
      })
    },

    async softDelete(input) {
      const exact = scope(input)
      const expectedVersion = validateExpectedVersion(input.expectedVersion)
      const operationId = validateOperationId(input.operationId)
      validateSessionIfPresent(input.sessionId)

      return db.transaction(async trx => {
        const row = await findExact(trx, exact, { version: expectedVersion })
        if (!row || row.status === 'deleted') throw new MemoryVersionConflictError()
        const before = toMemory(row)
        const changes = {
          status: 'deleted',
          version: expectedVersion + 1
        }
        const count = await trx('user_memories')
          .where({
            user_id: exact.userId,
            namespace: exact.namespace,
            memory_key: exact.memoryKey,
            version: expectedVersion
          })
          .update(changes)
        if (count !== 1) throw new MemoryVersionConflictError()
        const after = toMemory({ ...row, ...changes })
        await insertAudit(trx, {
          ...exact,
          action: 'delete',
          before,
          after,
          operationId
        })
        return after
      })
    }
  }
}
