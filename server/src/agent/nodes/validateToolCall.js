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

export function createValidateToolCallNode({
  tools = [],
  datasetStore,
  maxToolCalls
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

      const parsed = await allowed.schema.safeParseAsync(call.args)
      if (!parsed.success) {
        return { errors: [safeError('INVALID_TOOL_ARGUMENTS')] }
      }

      if (call.name === 'calculate_finance_metrics') {
        const runtime = graphConfig.context
        if (
          !datasetStore ||
          typeof datasetStore.get !== 'function' ||
          !runtime ||
          typeof runtime.requestId !== 'string'
        ) {
          return { errors: [safeError('DATASET_SCOPE_REJECTED')] }
        }
        try {
          await datasetStore.get({
            userId: runtime.userId,
            requestId: runtime.requestId,
            datasetRef: parsed.data.datasetRef
          })
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
