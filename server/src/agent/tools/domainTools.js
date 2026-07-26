import { tool } from 'langchain'
import { z } from 'zod'
import { queryFinanceSummary as defaultQueryFinanceSummary } from '../../services/financeQuery.js'
import { execute as defaultExecuteCalculation, CALCULATION_TYPES } from '../../services/calculatorAgent.js'
import { recordFromPlannerTask as defaultRecordFromPlannerTask } from '../../services/recorderAgent.js'

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

function missingBudgetAdapter() {
  throw new DomainToolExecutionError(
    'BUDGET_CHECK_UNAVAILABLE',
    'budget check is unavailable'
  )
}

export function createDomainTools({
  runtime,
  datasetStore,
  operationStore,
  queryFinanceSummary = defaultQueryFinanceSummary,
  executeCalculation = defaultExecuteCalculation,
  checkBudget = missingBudgetAdapter,
  recordFromPlannerTask = defaultRecordFromPlannerTask
}) {
  const queryTransactions = tool(async input => {
    const scope = queryScope(input)
    const summary = await queryFinanceSummary({
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
