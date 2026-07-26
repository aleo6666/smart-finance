import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { tool } from 'langchain'
import { z } from 'zod'
import defaultConfig from '../../config.js'
import { createLogger } from '../../utils/logger.js'
import {
  AdminSqlRejectedError,
  guardAdminSql
} from '../security/sqlGuard.js'

export class AdminSqlToolError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'AdminSqlToolError'
    this.code = code
    this.statusCode = statusCode
    this.expose = true
  }
}

function forbidden() {
  throw new AdminSqlToolError('FORBIDDEN', 'forbidden', 403)
}

function unavailable() {
  return new AdminSqlToolError(
    'ADMIN_SQL_UNAVAILABLE',
    'admin SQL unavailable',
    503
  )
}

function hasAnalysisIntent(value) {
  return String(value || '').split('+').includes('analysis')
}

function safeDuration(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function sqlTemplateHash(sql) {
  return createHash('sha256').update(String(sql)).digest('hex')
}

function trustedGate({ runtime, context, config }) {
  return runtime?.isAdmin === true &&
    context?.isAdmin === true &&
    context?.userId === runtime.userId &&
    context?.requestId === runtime.requestId &&
    hasAnalysisIntent(context.intentType ?? runtime.intentType) &&
    (context.domainGap ?? runtime.domainGap) === 'unsupported_depth' &&
    config?.agent?.adminSqlEnabled === true
}

export function createAdminSqlTool({
  runtime,
  config = defaultConfig,
  datasetStore,
  createPool = mysql.createPool,
  logger = createLogger('AdminSqlTool'),
  guard = guardAdminSql
}) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('runtime is required')
  }
  if (!datasetStore || typeof datasetStore.put !== 'function') {
    throw new TypeError('datasetStore must provide put')
  }

  let pool
  const getPool = () => {
    const sqlConfig = config?.adminSql ?? {}
    if (!sqlConfig.user || typeof sqlConfig.password !== 'string') {
      throw unavailable()
    }
    pool ??= createPool({
      host: sqlConfig.host,
      port: sqlConfig.port,
      database: sqlConfig.name,
      user: sqlConfig.user,
      password: sqlConfig.password,
      connectionLimit: 1
    })
    return pool
  }

  return tool(async (input, toolRuntime) => {
    const context = toolRuntime?.context
    if (!trustedGate({ runtime, context, config })) forbidden()

    const startedAt = performance.now()
    const hash = sqlTemplateHash(input.sql)
    let normalizedSql
    try {
      normalizedSql = guard(input.sql, {
        maxRows: config.adminSql.maxRows
      })
    } catch (error) {
      logger.warn('admin SQL rejected', {
        sqlTemplateHash: hash,
        durationMs: safeDuration(startedAt),
        errorCode: 'ADMIN_SQL_REJECTED'
      })
      if (error instanceof AdminSqlRejectedError) throw error
      throw new AdminSqlRejectedError()
    }

    try {
      const bindings = Array(
        (normalizedSql.match(/\?/g) ?? []).length
      ).fill(runtime.userId)
      const [queryRows] = await getPool().query({
        sql: normalizedSql,
        values: bindings,
        timeout: config.adminSql.timeoutMs
      })
      if (!Array.isArray(queryRows)) throw unavailable()
      const rows = queryRows.slice(0, config.adminSql.maxRows)
      const reference = await datasetStore.put({
        userId: runtime.userId,
        requestId: runtime.requestId,
        rows,
        summary: {
          source: 'admin_read_only_sql',
          rowCount: rows.length
        },
        scope: { queryKind: 'admin_analysis' }
      })
      logger.info('admin SQL completed', {
        sqlTemplateHash: hash,
        rowCount: rows.length,
        durationMs: safeDuration(startedAt)
      })
      return reference
    } catch (error) {
      const safeError = error?.code === 'ADMIN_SQL_UNAVAILABLE'
        ? error
        : unavailable()
      logger.warn('admin SQL failed', {
        sqlTemplateHash: hash,
        durationMs: safeDuration(startedAt),
        errorCode: safeError.code
      })
      throw safeError
    }
  }, {
    name: 'admin_read_only_sql',
    description: '管理员深度财务分析的只读安全视图查询，仅在领域工具明确数据深度不足后可用',
    schema: z.object({
      sql: z.string().trim().min(1).max(10_000)
    }),
    metadata: {
      adminSql: true
    }
  })
}
