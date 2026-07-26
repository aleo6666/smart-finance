import { interrupt } from '@langchain/langgraph'
import { hashOperation } from '../stores/operationStore.js'

const SENSITIVE_WRITE_TOOLS = new Set([
  'update_budget',
  'confirm_user_memory',
  'delete_user_memory',
  'update_transaction'
])

const WRITE_TOOLS = new Set([
  'record_transaction',
  ...SENSITIVE_WRITE_TOOLS
])

function objectMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
}

function lastToolCalls(state) {
  const calls = state?.messages?.at(-1)?.tool_calls
  return Array.isArray(calls) ? calls : []
}

function safeSummary(toolName, args) {
  const allowedFields = toolName === 'record_transaction'
    ? ['amount', 'type', 'category', 'currency']
    : toolName === 'update_budget'
      ? ['month', 'category', 'amount', 'limit']
      : toolName === 'update_transaction'
        ? ['transactionId', 'id']
        : ['namespace', 'memoryKey', 'expectedVersion']
  return Object.fromEntries(allowedFields.flatMap(key =>
    args[key] === undefined ? [] : [[key, args[key]]]
  ))
}

function fatalError(code) {
  return {
    code,
    source: 'risk_and_confirmation',
    fatal: true
  }
}

export function hasWriteToolCall(state) {
  return lastToolCalls(state).some(call => WRITE_TOOLS.has(call?.name))
}

export function createPendingConfirmationNode({
  tools,
  ttlMs,
  now = Date.now
}) {
  const byName = new Map(tools.map(item => [item.name, item]))

  return async (state, graphConfig = {}) => {
    const call = lastToolCalls(state).find(item => WRITE_TOOLS.has(item?.name))
    if (!call) return {}
    const parsed = await byName.get(call.name).schema.parseAsync(call.args)
    const operationId = graphConfig.context?.operationId
    const expiresAt = Number(now()) + ttlMs
    return {
      pendingConfirmation: {
        toolName: call.name,
        args: parsed,
        operationId,
        argsHash: hashOperation(parsed),
        safeSummary: safeSummary(call.name, parsed),
        expiresAt
      }
    }
  }
}

export function createRiskNode({
  amountThreshold,
  now = Date.now
}) {
  return async state => {
    const pending = objectMap(state.pendingConfirmation)
    if (!pending) {
      return { errors: [fatalError('CONFIRMATION_STATE_INVALID')] }
    }
    if (pending.executed === true) return {}

    const highAmount = pending.toolName === 'record_transaction' &&
      Number(pending.args?.amount) >= amountThreshold
    const sensitive = SENSITIVE_WRITE_TOOLS.has(pending.toolName)
    if (!highAmount && !sensitive) {
      return {
        pendingConfirmation: {
          ...pending,
          approved: true
        }
      }
    }

    const answer = interrupt({
      kind: 'financial_confirmation',
      operationId: pending.operationId,
      toolName: pending.toolName,
      summary: pending.safeSummary,
      reasons: highAmount ? ['high_amount'] : ['sensitive_write'],
      expiresAt: pending.expiresAt
    })
    if (Number(now()) >= pending.expiresAt) {
      return {
        pendingConfirmation: {
          ...pending,
          approved: false
        },
        errors: [fatalError('CONFIRMATION_EXPIRED')]
      }
    }
    return {
      pendingConfirmation: {
        ...pending,
        approved: answer?.approved === true
      }
    }
  }
}
