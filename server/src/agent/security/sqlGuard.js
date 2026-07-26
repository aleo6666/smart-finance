import sqlParser from 'node-sql-parser'

const { Parser } = sqlParser

const ALLOWED_VIEWS = new Set([
  'finance_records_safe',
  'finance_budgets_safe'
])

const ALLOWED_FUNCTIONS = new Set([
  'abs',
  'avg',
  'coalesce',
  'concat',
  'count',
  'date',
  'date_format',
  'day',
  'ifnull',
  'lower',
  'max',
  'min',
  'month',
  'round',
  'sum',
  'upper',
  'year'
])

const FORBIDDEN_TEXT = [
  /;/,
  /--/,
  /\/\*/,
  /#/,
  /\?/,
  /@/,
  /\bsleep\b/i,
  /\bbenchmark\b/i,
  /\bload_file\b/i,
  /\binto\s+outfile\b/i
]

export class AdminSqlRejectedError extends Error {
  constructor() {
    super('admin SQL rejected')
    this.name = 'AdminSqlRejectedError'
    this.code = 'ADMIN_SQL_REJECTED'
    this.statusCode = 400
    this.expose = true
  }
}

function reject() {
  throw new AdminSqlRejectedError()
}

function functionName(node) {
  if (typeof node?.name === 'string') return node.name.toLowerCase()
  const parts = node?.name?.name
  if (!Array.isArray(parts) || parts.length !== 1) reject()
  const value = parts[0]?.value
  if (typeof value !== 'string') reject()
  return value.toLowerCase()
}

function inspectExpressionTree(value, root) {
  if (!value || typeof value !== 'object') return
  if (value !== root && value.type === 'select') reject()
  if (value.type === 'function' || value.type === 'aggr_func') {
    const name = functionName(value)
    if (!ALLOWED_FUNCTIONS.has(name) || value.over) reject()
  }
  if (value.type === 'origin' && value.value === '?') reject()

  for (const [key, child] of Object.entries(value)) {
    if (key === '_next') continue
    if (Array.isArray(child)) {
      for (const item of child) inspectExpressionTree(item, root)
    } else {
      inspectExpressionTree(child, root)
    }
  }
}

function scopePredicate(source) {
  const qualifier = source.as || source.table
  return {
    type: 'binary_expr',
    operator: '=',
    left: {
      type: 'column_ref',
      table: qualifier,
      column: 'user_id'
    },
    right: {
      type: 'origin',
      value: '?'
    }
  }
}

function andExpressions(expressions) {
  return expressions.reduce((left, right) => left
    ? {
        type: 'binary_expr',
        operator: 'AND',
        left,
        right
      }
    : right, null)
}

function validateAndScopeSelect(ast) {
  if (!ast || ast.type !== 'select' || ast.with) reject()
  if (ast.options || ast.locking_read || ast.window) reject()
  if (ast.into && ast.into.position) reject()
  if (!Array.isArray(ast.from) || ast.from.length === 0) reject()

  const sources = ast.from.map(source => {
    if (
      !source ||
      source.expr ||
      source.db ||
      typeof source.table !== 'string' ||
      !ALLOWED_VIEWS.has(source.table.toLowerCase())
    ) {
      reject()
    }
    return source
  })

  inspectExpressionTree(ast, ast)
  const trustedScope = andExpressions(sources.map(scopePredicate))
  const modelPredicate = ast.where
    ? { ...ast.where, parentheses: true }
    : null
  ast.where = andExpressions([modelPredicate, trustedScope].filter(Boolean))

  if (ast._next) {
    if (!/^union(?:\s+all)?$/i.test(String(ast.set_op || ''))) reject()
    validateAndScopeSelect(ast._next)
  } else if (ast.set_op) {
    reject()
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function limitTarget(ast) {
  let target = ast
  while (target._next) target = target._next
  return target
}

function enforceLimit(ast, maxRows) {
  const target = limitTarget(ast)
  const values = target.limit?.value
  if (!values) {
    target.limit = {
      seperator: '',
      value: [{ type: 'number', value: maxRows }]
    }
    return
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 2) reject()
  const countIndex = target.limit.seperator === 'offset' ? 0 : values.length - 1
  const count = Number(values[countIndex]?.value)
  if (!positiveInteger(count)) reject()
  values[countIndex] = {
    type: 'number',
    value: Math.min(count, maxRows)
  }
}

export function guardAdminSql(sql, {
  parser = new Parser(),
  maxRows = 200
} = {}) {
  if (
    typeof sql !== 'string' ||
    !sql.trim() ||
    sql.length > 10_000 ||
    !positiveInteger(maxRows) ||
    FORBIDDEN_TEXT.some(pattern => pattern.test(sql))
  ) {
    reject()
  }

  let ast
  try {
    ast = parser.astify(sql, { database: 'MySQL' })
  } catch {
    reject()
  }
  if (Array.isArray(ast)) reject()

  validateAndScopeSelect(ast)
  enforceLimit(ast, maxRows)

  try {
    return parser.sqlify(ast, { database: 'MySQL' })
  } catch {
    reject()
  }
}
