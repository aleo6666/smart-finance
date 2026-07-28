import { CALCULATION_TYPES } from '../../services/calculatorAgent.js'

const DEFAULT_CALCULATION_TYPES = Object.freeze([
  CALCULATION_TYPES.CATEGORY_RATIO,
  CALCULATION_TYPES.PERIOD_COMPARISON,
  CALCULATION_TYPES.BUDGET_EXECUTION,
  CALCULATION_TYPES.SPENDING_TREND
])

function calculationTypesForScope(scope) {
  return scope.month
    ? DEFAULT_CALCULATION_TYPES
    : DEFAULT_CALCULATION_TYPES.filter(type =>
        type !== CALCULATION_TYPES.PERIOD_COMPARISON &&
        type !== CALCULATION_TYPES.SPENDING_TREND
    )
}

const SCOPE_FIELDS = new Set([
  'month',
  'startDate',
  'endDate',
  'category',
  'type',
  'queryKind'
])

function latestToolArgs(state) {
  const toolCalls = state?.messages?.at(-1)?.tool_calls
  const args = Array.isArray(toolCalls) ? toolCalls[0]?.args : null
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function analysisScope(state) {
  const scoped = {}
  for (const [key, value] of Object.entries(latestToolArgs(state))) {
    if (SCOPE_FIELDS.has(key) && value !== undefined) scoped[key] = value
  }
  return scoped
}

function toolInvoker(candidate, name) {
  const tool = candidate?.[name]
  if (typeof tool === 'function') return tool
  if (tool && typeof tool.invoke === 'function') {
    return (input, config) => tool.invoke(input, config)
  }
  throw new TypeError(`${name} tool is required`)
}

function datasetMetadata(value) {
  if (!value || typeof value !== 'object' || typeof value.datasetRef !== 'string') {
    return null
  }
  return {
    datasetRef: value.datasetRef,
    count: Number.isInteger(value.count) && value.count >= 0 ? value.count : 0,
    scope: value.scope && typeof value.scope === 'object' && !Array.isArray(value.scope)
      ? Object.fromEntries(
        Object.entries(value.scope).filter(([key, scopeValue]) =>
          SCOPE_FIELDS.has(key) &&
          typeof scopeValue === 'string' &&
          scopeValue.length <= 64
        )
      )
      : {}
  }
}

function mergeDatasetRefs(current, added) {
  const byRef = new Map()
  for (const item of current ?? []) {
    if (item && typeof item.datasetRef === 'string') {
      byRef.set(item.datasetRef, item)
    }
  }
  for (const item of added) {
    const metadata = datasetMetadata(item)
    if (metadata) byRef.set(metadata.datasetRef, metadata)
  }
  return [...byRef.values()]
}

function hasInvokeTool(tool) {
  return tool && typeof tool === 'object' && typeof tool.invoke === 'function'
}

async function runCalculations({
  calculateFinanceMetrics,
  transactions,
  budget,
  scope,
  config
}) {
  const transactionRef = transactions?.datasetRef
  const budgetRef = budget?.datasetRef
  if (typeof transactionRef !== 'string') return []
  const input = {
    ...scope,
    datasetRefs: [transactionRef, budgetRef].filter(Boolean),
    calculationTypes: calculationTypesForScope(scope)
  }
  const result = hasInvokeTool(calculateFinanceMetrics)
    ? await calculateFinanceMetrics.invoke(input, config)
    : await calculateFinanceMetrics(input, config)
  return [result]
}

export function createDomainAnalysisNode(tools) {
  const queryTransactions = toolInvoker(tools, 'queryTransactions')
  const checkBudget = toolInvoker(tools, 'checkBudget')
  const calculateFinanceMetrics = tools?.calculateFinanceMetrics
  if (
    typeof calculateFinanceMetrics !== 'function' &&
    !hasInvokeTool(calculateFinanceMetrics)
  ) {
    throw new TypeError('calculateFinanceMetrics tool is required')
  }

  return async (state, config) => {
    const scope = analysisScope(state)
    const [transactions, budget] = await Promise.all([
      queryTransactions(scope, config),
      checkBudget(scope, config)
    ])
    const calculations = await runCalculations({
      calculateFinanceMetrics,
      transactions,
      budget,
      scope,
      config
    })

    return {
      datasetRefs: mergeDatasetRefs([], [
        transactions,
        budget,
        ...calculations
      ])
    }
  }
}

export function createDomainAnalysisSubgraph(tools) {
  const node = createDomainAnalysisNode(tools)
  return {
    invoke(state, config) {
      return node(state, config)
    }
  }
}

