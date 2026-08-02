/**
 * 财务顾问 Agent 工具 — 将财务健康数据转化为结构化建议
 *
 * 安全约束:
 * - 仅提供财务规划和预算建议，不提供投资标的、收益承诺或交易指令
 * - 所有建议基于用户提供的实际数据，不编造
 * - 涉及敏感数据（如具体金额）时标注为建议而非确定结论
 */

import { tool } from 'langchain'
import { z } from 'zod'
import { analyzeFinancialHealth } from '../../services/financialHealth.js'

const CALCULATION_TYPES = Object.freeze([
  'financial_health',
  'savings_analysis',
  'spending_pattern',
  'budget_optimization',
  'goal_planning'
])

/**
 * 创建财务顾问工具
 *
 * @param {Object} options
 * @param {Object} options.runtime - 服务端 Runtime Context
 * @param {Object} options.datasetStore - 数据集存储
 * @returns {Array} 工具数组
 */
export function createAdvisorTools({ runtime, datasetStore }) {
  /**
   * 分析财务健康 — 从查询数据集计算完整健康指标
   */
  const analyzeFinancialHealthTool = tool(async (input) => {
    const dataset = await datasetStore.get({
      userId: runtime.userId,
      requestId: runtime.requestId,
      datasetRef: input.datasetRef
    })

    if (!dataset) {
      return {
        status: 'error',
        error: { code: 'DATASET_NOT_FOUND', message: '请先查询财务数据后再请求分析' }
      }
    }

    const summary = dataset.summary || {}
    const rows = Array.isArray(dataset.rows) ? dataset.rows : []

    // 从数据集构建财务快照
    const snapshot = {
      totalIncome: Number(summary.totalIncome ?? 0),
      totalExpense: Number(summary.totalExpense ?? summary.total ?? 0),
      categoryBreakdown: summary.categoryStats || rows.filter(r => r.category),
      budgets: summary.budgets || [],
      monthCount: Number(summary.monthCount || 1),
      totalSavings: Number(summary.totalSavings || 0),
      previousMonth: summary.previous || null
    }

    const report = analyzeFinancialHealth(snapshot)

    return await datasetStore.put({
      userId: runtime.userId,
      requestId: runtime.requestId,
      rows: [],
      summary: {
        source: 'financial_advisor',
        ...report
      },
      scope: dataset.scope || {}
    })
  }, {
    name: 'analyze_financial_health',
    description: `分析当前财务健康状态，生成包含以下维度的完整报告：
- 储蓄率与收支平衡
- 预算执行情况
- 消费结构集中度
- 财务健康评分 (0-100)
- 个性化改进建议

注意：此工具不提供投资建议，仅分析用户的消费和储蓄模式。`,
    schema: z.object({
      datasetRef: z.string().describe('query_transactions 或 check_budget 返回的数据集引用'),
      analysisType: z.enum(['full', 'summary', 'budgets', 'spending']).default('full')
        .describe('分析类型: full=完整报告, summary=摘要, budgets=仅预算, spending=仅消费模式')
    })
  })

  /**
   * 目标规划 — 帮助用户制定和评估财务目标
   */
  const planFinancialGoal = tool(async (input) => {
    const { goalType, targetAmount, currentSavings, monthlySaving, timelineMonths } = input

    const needed = targetAmount - (currentSavings || 0)
    const requiredMonthly = timelineMonths > 0 ? needed / timelineMonths : 0
    const feasible = monthlySaving >= requiredMonthly

    const plan = {
      goalType,
      targetAmount,
      currentSavings: currentSavings || 0,
      gap: needed,
      monthlySaving,
      requiredMonthlySaving: Math.round(requiredMonthly),
      timelineMonths,
      feasible,
      suggestion: feasible
        ? `按当前每月存 ${monthlySaving} 元的速度，预计 ${timelineMonths} 个月可达成本目标。`
        : `当前每月存 ${monthlySaving} 元不足以在 ${timelineMonths} 个月内达成目标（需 ${Math.round(requiredMonthly)} 元/月）。建议延长时限或增加储蓄。`
    }

    return await datasetStore.put({
      userId: runtime.userId,
      requestId: runtime.requestId,
      rows: [],
      summary: { source: 'goal_planner', plan },
      scope: {}
    })
  }, {
    name: 'plan_financial_goal',
    description: '帮助用户规划财务目标（如储蓄目标、大额消费计划），评估可行性并给出建议',
    schema: z.object({
      goalType: z.enum(['savings', 'purchase', 'investment', 'debt_repayment', 'emergency_fund'])
        .describe('目标类型'),
      targetAmount: z.number().positive().describe('目标金额（元）'),
      currentSavings: z.number().min(0).optional().describe('当前已存金额'),
      monthlySaving: z.number().min(0).describe('每月可存金额'),
      timelineMonths: z.number().int().positive().max(120).describe('计划月数')
    })
  })

  return [analyzeFinancialHealthTool, planFinancialGoal]
}

export default { createAdvisorTools }

// 工具名常量，供 graph.js 引用
export const ADVISOR_TOOL_NAMES = new Set([
  'analyze_financial_health',
  'plan_financial_goal'
])
