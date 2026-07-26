import { tool } from 'langchain'
import { z } from 'zod'
import db from '../../db.js'
import { queryFinanceSummary as defaultQueryFinanceSummary } from '../../services/financeQuery.js'
import {
  execute as defaultExecuteCalculation,
  calculateBudgetExecution as defaultCalculateBudgetExecution,
  CALCULATION_TYPES
} from '../../services/calculatorAgent.js'
import { recordFromPlannerTask as defaultRecordFromPlannerTask } from '../../services/recorderAgent.js'
import {
  retrieveBudgetConfig as defaultRetrieveBudgetConfig,
  retrieveCategoryStats as defaultRetrieveCategoryStats
} from '../../services/retrievalAgent.js'

const calculationTypes = Object.values(CALCULATION_TYPES)

export class DomainToolExecutionError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message)
    this.name = 'DomainToolExecutionError'
    this.code = code
    this.statusCode = statusCode
    this.expose = true
  }
}

function queryScope(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function calculationParams(type, dataset, input) {
  const summary = dataset.summary || {}
  switch (type) {
    case CALCULATION_TYPES.BUDGET_EXECUTION:
      return {
        budgets: summary.budgets || [],
        categoryStats: summary.categoryStats || dataset.rows,
        totalSpending: Number(summary.totalSpending ?? summary.total ?? 0),
        month: input.month ?? dataset.scope?.month ?? null
      }
    case CALCULATION_TYPES.PERIOD_COMPARISON:
      return {
        current: summary.current || {
          total: summary.total || 0,
          count: summary.count || dataset.rows.length
        },
        previous: summary.previous || { total: 0, count: 0 },
        periodLabel: input.periodLabel
      }
    case CALCULATION_TYPES.COMPLIANCE_CHECK:
      return {
        record: dataset.rows[0] || null,
        budgetExecution: summary.budgetExecution || null
      }
    case CALCULATION_TYPES.CATEGORY_RATIO:
      return { categoryStats: summary.categoryStats || dataset.rows }
    case CALCULATION_TYPES.SPENDING_TREND:
      return { dataPoints: summary.dataPoints || dataset.rows }
    default:
      throw new DomainToolExecutionError('INVALID_CALCULATION_TYPE', 'calculation type is invalid', 400)
  }
}

function normalizeDateRangeRecord(record) {
  const amount = Number(record.amount_cny ?? record.amount ?? 0)
  return {
    ...record,
    amount,
    amount_cny: amount
  }
}

function applyDateRangeFilters(query, { userId, hints }) {
  query
    .where('user_id', userId)
    .where('date', '>=', hints.startDate)
    .where('date', '<=', hints.endDate)
  if (hints.category) query.where('category', hints.category)
  if (hints.type) query.where('type', hints.type)
  return query
}

export async function queryFinanceDateRange({
  userId,
  hints,
  dbClient = db,
  limit = 5
}) {
  const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 5))
  const aggregateRows = await applyDateRangeFilters(dbClient('records'), {
    userId,
    hints
  }).select(
    dbClient.raw('COUNT(*) as count'),
    dbClient.raw('SUM(COALESCE(amount_cny, amount)) as total')
  )
  const aggregate = aggregateRows[0] || {}

  const maxRows = await applyDateRangeFilters(dbClient('records'), {
    userId,
    hints
  })
    .orderByRaw('COALESCE(amount_cny, amount) DESC')
    .limit(1)
    .select()
  const maxRecord = maxRows[0] ? normalizeDateRangeRecord(maxRows[0]) : null

  const recordsQuery = applyDateRangeFilters(dbClient('records'), {
    userId,
    hints
  })
  if (hints.queryKind === 'largest') {
    recordsQuery.orderByRaw('COALESCE(amount_cny, amount) DESC')
  } else {
    recordsQuery.orderBy('date', 'desc')
  }
  const records = (await recordsQuery.limit(boundedLimit).select())
    .map(normalizeDateRangeRecord)
  const count = Number(aggregate.count || 0)
  const total = Number(aggregate.total || 0)
  return {
    hints,
    count,
    total,
    average: count ? total / count : 0,
    maxRecord,
    records
  }
}

export async function checkBudgetWithExistingServices({
  userId,
  month,
  category,
  retrieveBudgetConfig = defaultRetrieveBudgetConfig,
  retrieveCategoryStats = defaultRetrieveCategoryStats,
  calculateBudgetExecution = defaultCalculateBudgetExecution
}) {
  try {
    const [budgetResult, statsResult] = await Promise.all([
      retrieveBudgetConfig({ userId, month }),
      retrieveCategoryStats({ userId, month })
    ])
    if (!budgetResult?.success || !statsResult?.success) {
      throw new Error('retrieval failed')
    }
    const budgets = Array.isArray(budgetResult.data?.budgets)
      ? budgetResult.data.budgets
      : []
    const stats = Array.isArray(statsResult.data?.stats)
      ? statsResult.data.stats
      : []
    const categoryBudgets = category
      ? budgets.filter(item => item.category === category)
      : budgets
    const categoryStats = category
      ? stats.filter(item => item.category === category)
      : stats
    const result = calculateBudgetExecution({
      budgets: categoryBudgets,
      categoryStats,
      totalSpending: categoryStats.reduce(
        (sum, item) => sum + Number(item.total || 0),
        0
      ),
      month
    })
    if (!result?.success) throw new Error('calculation failed')
    return result
  } catch {
    throw new DomainToolExecutionError(
      'BUDGET_CHECK_UNAVAILABLE',
      'budget check is unavailable'
    )
  }
}

export function createDomainTools({
  runtime,
  datasetStore,
  operationStore,
  queryFinanceSummary = defaultQueryFinanceSummary,
  queryFinanceDateRange: queryFinanceDateRangeAdapter = queryFinanceDateRange,
  executeCalculation = defaultExecuteCalculation,
  checkBudget = checkBudgetWithExistingServices,
  recordFromPlannerTask = defaultRecordFromPlannerTask
}) {
  const queryTransactions = tool(async input => {
    const scope = queryScope(input)
    const summary = await (input.startDate
      ? queryFinanceDateRangeAdapter
      : queryFinanceSummary)({
      userId: runtime.userId,
      hints: scope
    })
    return datasetStore.put({
      userId: runtime.userId,
      requestId: runtime.requestId,
      rows: Array.isArray(summary.records) ? summary.records : [],
      summary,
      scope
    })
  }, {
    name: 'query_transactions',
    description: '按结构化条件精确查询当前用户账单，返回当前请求可用的数据集引用',
    schema: z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
      startDate: z.iso.date().optional(),
      endDate: z.iso.date().optional(),
      category: z.string().trim().min(1).max(64).optional(),
      type: z.enum(['income', 'expense']).optional(),
      queryKind: z.enum(['summary', 'recent', 'largest']).default('summary')
    }).superRefine((value, context) => {
      const hasStart = value.startDate !== undefined
      const hasEnd = value.endDate !== undefined
      if (hasStart !== hasEnd) {
        context.addIssue({
          code: 'custom',
          message: 'startDate and endDate must be provided together'
        })
      } else if (hasStart && value.startDate > value.endDate) {
        context.addIssue({
          code: 'custom',
          message: 'startDate must not be after endDate'
        })
      }
    })
  })

  const calculateFinanceMetrics = tool(async input => {
    const dataset = await datasetStore.get({
      userId: runtime.userId,
      requestId: runtime.requestId,
      datasetRef: input.datasetRef
    })
    return executeCalculation({
      type: input.calculationType,
      params: calculationParams(input.calculationType, dataset, input)
    })
  }, {
    name: 'calculate_finance_metrics',
    description: '基于当前请求的账单数据集执行确定性财务计算',
    schema: z.object({
      datasetRef: z.string().regex(/^ds_[A-Za-z0-9-]{1,128}$/),
      calculationType: z.enum(calculationTypes),
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
      periodLabel: z.string().trim().min(1).max(64).optional()
    })
  })

  const checkBudgetTool = tool(async input => checkBudget({
    userId: runtime.userId,
    month: input.month,
    category: input.category
  }), {
    name: 'check_budget',
    description: '检查当前用户指定月份和分类的预算使用情况',
    schema: z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
      category: z.string().trim().min(1).max(64).optional()
    })
  })

  const recordTransaction = tool(async input => {
    const claim = await operationStore.claim({
      userId: runtime.userId,
      operationId: runtime.operationId,
      operationType: 'record_transaction',
      input
    })
    if (claim.status === 'succeeded') return claim.result
    if (claim.status === 'in_progress') return { status: 'in_progress' }
    if (claim.status !== 'owner') {
      throw new DomainToolExecutionError('OPERATION_FAILED', 'record operation is unavailable')
    }

    try {
      const result = await recordFromPlannerTask({
        task: {
          payload: {
            userId: runtime.userId,
            deviceId: `user-${runtime.userId}`,
            record: input
          }
        }
      })
      await operationStore.succeed({
        userId: runtime.userId,
        operationId: runtime.operationId,
        inputHash: claim.inputHash,
        result
      })
      return result
    } catch {
      await operationStore.fail({
        userId: runtime.userId,
        operationId: runtime.operationId,
        inputHash: claim.inputHash,
        errorCode: 'RECORD_TRANSACTION_FAILED'
      }).catch(() => {})
      throw new DomainToolExecutionError(
        'RECORD_TRANSACTION_FAILED',
        'record transaction failed'
      )
    }
  }, {
    name: 'record_transaction',
    description: '为当前用户写入一笔账单；重复请求不会重复记账',
    schema: z.object({
      amount: z.number().finite().positive(),
      type: z.enum(['income', 'expense']).default('expense'),
      category: z.string().trim().min(1).max(64),
      description: z.string().max(500).optional(),
      date: z.iso.date().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).default('CNY'),
      ledgerId: z.number().int().positive().optional(),
      merchant: z.string().max(128).optional(),
      project: z.string().max(128).optional(),
      member: z.string().max(128).optional()
    })
  })

  return [
    queryTransactions,
    calculateFinanceMetrics,
    checkBudgetTool,
    recordTransaction
  ]
}
