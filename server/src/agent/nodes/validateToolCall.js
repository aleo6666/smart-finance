const TRUSTED_ARGUMENT_KEYS = new Set([
  'userid',
  'sessionid',
  'requestid',
  'operationid',
  'isadmin'
])

function safeError(code) {
  return {
    code,
    source: 'validate_tool_call',
    fatal: true
  }
}

function lastToolCalls(messages) {
  if (!Array.isArray(messages)) return []
  const last = messages.at(-1)
  return Array.isArray(last?.tool_calls) ? last.tool_calls : []
}

function containsTrustedArgument(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replaceAll('_', '').toLowerCase()
    if (TRUSTED_ARGUMENT_KEYS.has(normalizedKey)) return true
    if (containsTrustedArgument(child, seen)) return true
  }
  seen.delete(value)
  return false
}

function toolMap(tools) {
  const map = new Map()
  for (const item of tools) {
    if (!item || typeof item.name !== 'string' || !item.schema) {
      throw new TypeError('tools must provide a name and schema')
    }
    if (map.has(item.name)) throw new TypeError('tool names must be unique')
    map.set(item.name, item)
  }
  return map
}

function timezoneDateParts(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day)
    }
  } catch {
    return timezoneDateParts(date, 'Asia/Shanghai')
  }
}

function ymd(parts) {
  return [
    parts.year,
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-')
}

function shiftDateParts(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

function normalizeAmount(value) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return value
  const match = value.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : value
}

function normalizeType(value) {
  if (value === 'income' || value === 'expense') return value
  const text = String(value ?? '').trim().toLowerCase()
  if (/^(收入|收款|入账|income)$/.test(text)) return 'income'
  if (/^(支出|消费|花费|付款|缴费|交费|expense)$/.test(text)) return 'expense'
  return value
}

function normalizeCurrency(value) {
  if (value === undefined) return value
  const text = String(value ?? '').trim().toUpperCase()
  if (['CNY', 'RMB', '人民币', '元', '￥'].includes(text)) return 'CNY'
  return value
}

function normalizeDate(value, { timezone, now }) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return value
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10)

  const today = timezoneDateParts(now(), timezone)
  if (/^(今天|今日|today)$/i.test(text)) return ymd(today)
  if (/^(昨天|昨日|yesterday)$/i.test(text)) return ymd(shiftDateParts(today, -1))
  if (/^(前天)$/.test(text)) return ymd(shiftDateParts(today, -2))

  const chineseDate = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/)
  if (chineseDate) {
    return ymd({
      year: Number(chineseDate[1]),
      month: Number(chineseDate[2]),
      day: Number(chineseDate[3])
    })
  }

  return value
}

function normalizeRecordTransactionArgs(args, options) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  return {
    ...args,
    ...(args.amount !== undefined ? { amount: normalizeAmount(args.amount) } : {}),
    ...(args.type !== undefined ? { type: normalizeType(args.type) } : {}),
    ...(args.date !== undefined ? { date: normalizeDate(args.date, options) } : {}),
    ...(args.currency !== undefined ? { currency: normalizeCurrency(args.currency) } : {})
  }
}

export function createValidateToolCallNode({
  tools = [],
  datasetStore,
  maxToolCalls,
  now = () => new Date()
}) {
  if (!Number.isInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new TypeError('maxToolCalls must be a positive integer')
  }
  const allowedTools = toolMap(tools)

  return async (state, graphConfig = {}) => {
    const calls = lastToolCalls(state?.messages)
    const currentCount = Number.isInteger(state?.toolCallCount) &&
      state.toolCallCount >= 0
      ? state.toolCallCount
      : 0

    if (currentCount + calls.length > maxToolCalls) {
      return { errors: [safeError('TOOL_CALL_LIMIT')] }
    }

    for (const call of calls) {
      const allowed = allowedTools.get(call?.name)
      if (!allowed) return { errors: [safeError('UNKNOWN_TOOL')] }
      if (containsTrustedArgument(call.args)) {
        return { errors: [safeError('TRUSTED_ARGUMENT_REJECTED')] }
      }

      if (call.name === 'record_transaction') {
        call.args = normalizeRecordTransactionArgs(call.args, {
          timezone: graphConfig.context?.timezone,
          now
        })
      }

      const parsed = await allowed.schema.safeParseAsync(call.args)
      if (!parsed.success) {
        return { errors: [safeError('INVALID_TOOL_ARGUMENTS')] }
      }
      call.args = parsed.data

      if (call.name === 'calculate_finance_metrics') {
        const runtime = graphConfig.context
        const datasetRefs = parsed.data.datasetRefs ?? [parsed.data.datasetRef]
        if (
          !datasetStore ||
          typeof datasetStore.get !== 'function' ||
          !runtime ||
          typeof runtime.requestId !== 'string' ||
          datasetRefs.some(datasetRef => typeof datasetRef !== 'string')
        ) {
          return { errors: [safeError('DATASET_SCOPE_REJECTED')] }
        }
        try {
          await Promise.all(datasetRefs.map(datasetRef =>
            datasetStore.get({
              userId: runtime.userId,
              requestId: runtime.requestId,
              datasetRef
            })
          ))
        } catch {
          return { errors: [safeError('DATASET_SCOPE_REJECTED')] }
        }
      }
    }

    return {
      toolCallCount: currentCount + calls.length
    }
  }
}
