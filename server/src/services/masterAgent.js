/**
 * 主控 Agent（调度中心）- 极简 3 Agent 主从协同架构
 *
 * 架构：单主控 + 两个执行 Agent
 *   主控 Agent (本文件)   → 任务拆解、调度分发、结果汇总
 *   ├─ 检索 Agent         → RAG、数据查询、规则匹配
 *   └─ 计算 Agent         → 财务运算、指标计算、合规校验
 *
 * 执行流程：
 *   用户提问 → 主控拆解任务 → 分发至检索/计算 Agent → 结果回传 → 主控整合输出
 *
 * 设计原则：极简优先，规则驱动，可逐步升级为 LLM 调度
 */

import retrievalAgent, { RETRIEVAL_TYPES } from './retrievalAgent.js'
import calculatorAgent, { CALCULATION_TYPES } from './calculatorAgent.js'
import analystAgent, { ANALYSIS_TYPES } from './financialAnalystAgent.js'
import cfpAgent, { PLANNING_TYPES } from './cfpPlannerAgent.js'
import { extractQueryHints } from './chatMemory.js'

// ---- 任务模式定义 ----

const TASK_PATTERNS = {
  // 纯查询：只需要检索
  SIMPLE_QUERY: 'simple_query',
  // 预算分析：检索 + 计算（预算执行）
  BUDGET_ANALYSIS: 'budget_analysis',
  // 综合分析：多维度检索 + 多维度计算
  COMPREHENSIVE_ANALYSIS: 'comprehensive_analysis',
  // 周期对比：双周期检索 + 对比计算
  PERIOD_COMPARISON: 'period_comparison',
  // 分类分析：分类统计检索 + 占比计算
  CATEGORY_ANALYSIS: 'category_analysis',
  // 专业分析建议：多维度检索 + 计算 + LLM 财务分析师生成建议
  PROFESSIONAL_ADVICE: 'professional_advice',
  // CFP 家庭理财规划：高端完整财务方案，面向高净值家庭
  FAMILY_PLANNING: 'family_planning'
}

// ---- 意图识别（规则驱动，极简版）----

function detectTaskPattern(message) {
  const text = String(message || '')

  // 预算相关
  if (/(预算|超支|省钱|节流|控支)/.test(text)) {
    return TASK_PATTERNS.BUDGET_ANALYSIS
  }

  // 对比相关
  if (/(对比|比较|环比|同比|上月|上个月|去年)/.test(text)) {
    return TASK_PATTERNS.PERIOD_COMPARISON
  }

  // 分类/占比相关
  if (/(分类|占比|构成|花在哪|主要消费)/.test(text)) {
    return TASK_PATTERNS.CATEGORY_ANALYSIS
  }

  // 专业分析/建议（需要财务分析师介入）
  if (/(专业分析|财务顾问|私人助理|理财建议|诊断一下|给点建议|优化建议|储蓄规划|存钱计划|健康报告|月度报告)/.test(text)) {
    return TASK_PATTERNS.PROFESSIONAL_ADVICE
  }

  // CFP 家庭理财规划（高端完整方案）
  if (/(家庭理财|完整规划|财务规划|CFP|理财师|高净值|资产配置|养老规划|教育金|保险规划|负债管理|应急资金|财富管理)/.test(text)) {
    return TASK_PATTERNS.FAMILY_PLANNING
  }

  // 综合分析
  if (/(全面|综合|整体|详细|深度).*(分析|报告|复盘|总结)/.test(text) ||
      /(分析|报告|复盘|总结).*(建议|规划|方案)/.test(text)) {
    return TASK_PATTERNS.COMPREHENSIVE_ANALYSIS
  }

  // 默认简单查询
  return TASK_PATTERNS.SIMPLE_QUERY
}

// ---- 任务计划生成 ----

function buildTaskPlan({ pattern, userId, message, hints = {} }) {
  const now = new Date()
  const thisMonth = now.toISOString().slice(0, 7)
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonth = prevDate.toISOString().slice(0, 7)

  const plans = {
    [TASK_PATTERNS.SIMPLE_QUERY]: () => ({
      pattern,
      steps: [
        {
          id: 'retrieve_summary',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
          params: { hints: { ...hints, queryKind: 'summary' } },
          depends_on: []
        }
      ]
    }),

    [TASK_PATTERNS.BUDGET_ANALYSIS]: () => ({
      pattern,
      steps: [
        {
          id: 'retrieve_budget',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.BUDGET_CONFIG,
          params: { month: thisMonth },
          depends_on: []
        },
        {
          id: 'retrieve_category_stats',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.CATEGORY_STATS,
          params: { month: thisMonth },
          depends_on: []
        },
        {
          id: 'calc_budget_execution',
          agent: 'calculator',
          type: CALCULATION_TYPES.BUDGET_EXECUTION,
          paramsFrom: ['retrieve_budget', 'retrieve_category_stats'],
          depends_on: ['retrieve_budget', 'retrieve_category_stats']
        }
      ]
    }),

    [TASK_PATTERNS.PERIOD_COMPARISON]: () => ({
      pattern,
      steps: [
        {
          id: 'retrieve_current',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
          params: { hints: { month: thisMonth, queryKind: 'summary' } },
          depends_on: []
        },
        {
          id: 'retrieve_previous',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
          params: { hints: { month: lastMonth, queryKind: 'summary' } },
          depends_on: []
        },
        {
          id: 'calc_comparison',
          agent: 'calculator',
          type: CALCULATION_TYPES.PERIOD_COMPARISON,
          paramsFrom: ['retrieve_current', 'retrieve_previous'],
          depends_on: ['retrieve_current', 'retrieve_previous']
        }
      ]
    }),

    [TASK_PATTERNS.CATEGORY_ANALYSIS]: () => ({
      pattern,
      steps: [
        {
          id: 'retrieve_categories',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.CATEGORY_STATS,
          params: { month: hints.month || thisMonth },
          depends_on: []
        },
        {
          id: 'calc_category_ratio',
          agent: 'calculator',
          type: CALCULATION_TYPES.CATEGORY_RATIO,
          paramsFrom: ['retrieve_categories'],
          depends_on: ['retrieve_categories']
        }
      ]
    }),

    [TASK_PATTERNS.PROFESSIONAL_ADVICE]: () => ({
      pattern,
      steps: [
        // 第一轮：并行检索
        {
          id: 'retrieve_summary',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
          params: { hints: { ...hints, month: thisMonth, queryKind: 'summary' } },
          depends_on: []
        },
        {
          id: 'retrieve_budget',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.BUDGET_CONFIG,
          params: { month: thisMonth },
          depends_on: []
        },
        {
          id: 'retrieve_categories',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.CATEGORY_STATS,
          params: { month: thisMonth },
          depends_on: []
        },
        // 第二轮：并行计算
        {
          id: 'calc_budget',
          agent: 'calculator',
          type: CALCULATION_TYPES.BUDGET_EXECUTION,
          paramsFrom: ['retrieve_budget', 'retrieve_categories'],
          depends_on: ['retrieve_budget', 'retrieve_categories']
        },
        {
          id: 'calc_categories',
          agent: 'calculator',
          type: CALCULATION_TYPES.CATEGORY_RATIO,
          paramsFrom: ['retrieve_categories'],
          depends_on: ['retrieve_categories']
        },
        // 第三轮：财务分析师生成专业建议
        {
          id: 'analyst_report',
          agent: 'analyst',
          type: ANALYSIS_TYPES.MONTHLY_REPORT,
          paramsFrom: ['retrieve_summary', 'calc_budget', 'calc_categories'],
          depends_on: ['retrieve_summary', 'calc_budget', 'calc_categories']
        }
      ]
    }),

    [TASK_PATTERNS.FAMILY_PLANNING]: () => ({
      pattern,
      steps: [
        // 第一轮：并行检索基础数据
        {
          id: 'retrieve_summary',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
          params: { hints: { ...hints, month: thisMonth, queryKind: 'summary' } },
          depends_on: []
        },
        {
          id: 'retrieve_budget',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.BUDGET_CONFIG,
          params: { month: thisMonth },
          depends_on: []
        },
        {
          id: 'retrieve_categories',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.CATEGORY_STATS,
          params: { month: thisMonth },
          depends_on: []
        },
        // 第二轮：并行计算财务指标
        {
          id: 'calc_budget',
          agent: 'calculator',
          type: CALCULATION_TYPES.BUDGET_EXECUTION,
          paramsFrom: ['retrieve_budget', 'retrieve_categories'],
          depends_on: ['retrieve_budget', 'retrieve_categories']
        },
        {
          id: 'calc_categories',
          agent: 'calculator',
          type: CALCULATION_TYPES.CATEGORY_RATIO,
          paramsFrom: ['retrieve_categories'],
          depends_on: ['retrieve_categories']
        },
        // 第三轮：CFP 理财师生成完整家庭财务规划
        {
          id: 'cfp_full_plan',
          agent: 'cfp',
          type: PLANNING_TYPES.FULL_FINANCIAL_PLAN,
          paramsFrom: ['retrieve_summary', 'calc_budget', 'calc_categories'],
          depends_on: ['retrieve_summary', 'calc_budget', 'calc_categories']
        }
      ]
    }),

    [TASK_PATTERNS.COMPREHENSIVE_ANALYSIS]: () => ({
      pattern,
      steps: [
        // 第一轮：并行检索
        {
          id: 'retrieve_summary',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
          params: { hints: { ...hints, queryKind: 'summary' } },
          depends_on: []
        },
        {
          id: 'retrieve_budget',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.BUDGET_CONFIG,
          params: { month: thisMonth },
          depends_on: []
        },
        {
          id: 'retrieve_categories',
          agent: 'retrieval',
          type: RETRIEVAL_TYPES.CATEGORY_STATS,
          params: { month: thisMonth },
          depends_on: []
        },
        // 第二轮：并行计算（依赖第一轮结果）
        {
          id: 'calc_budget',
          agent: 'calculator',
          type: CALCULATION_TYPES.BUDGET_EXECUTION,
          paramsFrom: ['retrieve_budget', 'retrieve_categories'],
          depends_on: ['retrieve_budget', 'retrieve_categories']
        },
        {
          id: 'calc_categories',
          agent: 'calculator',
          type: CALCULATION_TYPES.CATEGORY_RATIO,
          paramsFrom: ['retrieve_categories'],
          depends_on: ['retrieve_categories']
        }
      ]
    })
  }

  const factory = plans[pattern]
  if (!factory) return null
  return factory()
}

// ---- 参数装配：将前置步骤输出转为计算输入 ----

function assembleParams(step, results) {
  if (!step.paramsFrom || step.paramsFrom.length === 0) {
    return step.params || {}
  }

  const inputs = {}
  for (const sourceId of step.paramsFrom) {
    const result = results[sourceId]
    if (!result?.success || !result.data) continue

    switch (step.type) {
      case CALCULATION_TYPES.BUDGET_EXECUTION:
        if (result.type === RETRIEVAL_TYPES.BUDGET_CONFIG) {
          inputs.budgets = result.data.budgets
          inputs.month = result.data.month
        }
        if (result.type === RETRIEVAL_TYPES.CATEGORY_STATS) {
          inputs.categoryStats = result.data.stats
          inputs.totalSpending = result.data.grandTotal
        }
        break

      case CALCULATION_TYPES.PERIOD_COMPARISON:
        if (sourceId.includes('current')) {
          inputs.current = { total: result.data.total, count: result.data.count }
        }
        if (sourceId.includes('previous')) {
          inputs.previous = { total: result.data.total, count: result.data.count }
        }
        inputs.periodLabel = '环比'
        break

      case CALCULATION_TYPES.CATEGORY_RATIO:
        if (result.type === RETRIEVAL_TYPES.CATEGORY_STATS) {
          inputs.categoryStats = result.data.stats
        }
        break

      case ANALYSIS_TYPES.MONTHLY_REPORT:
        if (result.type === RETRIEVAL_TYPES.FINANCE_SUMMARY) {
          inputs.summary = result.data
        }
        if (result.type === CALCULATION_TYPES.BUDGET_EXECUTION) {
          inputs.budgetExecution = result.data
        }
        if (result.type === CALCULATION_TYPES.CATEGORY_RATIO) {
          inputs.categoryRatio = result.data
        }
        if (result.data?.month) inputs.month = result.data.month
        break

      case PLANNING_TYPES.FULL_FINANCIAL_PLAN:
        if (result.type === RETRIEVAL_TYPES.FINANCE_SUMMARY) {
          inputs.summary = result.data
        }
        if (result.type === CALCULATION_TYPES.BUDGET_EXECUTION) {
          inputs.budgetExecution = result.data
        }
        if (result.type === CALCULATION_TYPES.CATEGORY_RATIO) {
          inputs.categoryRatio = result.data
        }
        break

      default:
        Object.assign(inputs, result.data)
    }
  }

  return { ...(step.params || {}), ...inputs }
}

// ---- 计划执行引擎 ----

async function executePlan({ plan, userId }) {
  if (!plan || !Array.isArray(plan.steps)) {
    return { success: false, error: '无效的任务计划' }
  }

  const results = {}    // { stepId: result }
  const pending = new Set(plan.steps.map(s => s.id))
  const stepMap = new Map(plan.steps.map(s => [s.id, s]))

  while (pending.size > 0) {
    // 找出所有依赖已满足的步骤
    const ready = []
    for (const stepId of pending) {
      const step = stepMap.get(stepId)
      const deps = step.depends_on || []
      const allReady = deps.every(depId => !pending.has(depId) && results[depId])
      if (allReady) ready.push(step)
    }

    if (ready.length === 0) {
      // 死锁保护
      for (const stepId of pending) {
        results[stepId] = { success: false, error: '依赖无法满足', skipped: true }
        pending.delete(stepId)
      }
      break
    }

    // 并发执行本轮所有就绪步骤
    const roundResults = await Promise.all(ready.map(async (step) => {
      const params = assembleParams(step, results)

      let result
      if (step.agent === 'retrieval') {
        result = await retrievalAgent.execute({ type: step.type, userId, params })
      } else if (step.agent === 'calculator') {
        result = await calculatorAgent.execute({ type: step.type, params })
      } else if (step.agent === 'analyst') {
        result = await analystAgent.execute({ type: step.type, params })
      } else if (step.agent === 'cfp') {
        result = await cfpAgent.execute({ type: step.type, params })
      } else {
        result = { success: false, error: `未知 Agent 类型: ${step.agent}` }
      }

      return { stepId: step.id, result }
    }))

    for (const { stepId, result } of roundResults) {
      results[stepId] = result
      pending.delete(stepId)
    }
  }

  return {
    success: true,
    pattern: plan.pattern,
    results,
    stepCount: plan.steps.length,
    succeededCount: Object.values(results).filter(r => r.success).length,
    failedCount: Object.values(results).filter(r => !r.success).length
  }
}

// ---- 结果汇总与回答生成 ----

function synthesizeAnswer({ executionResult, message }) {
  const { results, pattern } = executionResult
  const parts = []

  switch (pattern) {
    case TASK_PATTERNS.SIMPLE_QUERY: {
      const summary = results.retrieve_summary?.data
      if (summary?.count > 0) {
        parts.push(`📊 消费统计：共 ${summary.total.toFixed(2)} 元，合计 ${summary.count} 笔，平均每笔 ${summary.average.toFixed(2)} 元`)
        if (summary.maxRecord) {
          parts.push(`💸 最大单笔：${summary.maxRecord.amount.toFixed(2)} 元（${summary.maxRecord.date}）`)
        }
      } else {
        parts.push('暂无消费记录，先记一笔吧～')
      }
      break
    }

    case TASK_PATTERNS.BUDGET_ANALYSIS: {
      const budgetCalc = results.calc_budget_execution?.data
      if (budgetCalc) {
        const { summary, items } = budgetCalc
        parts.push(`💰 预算执行（${budgetCalc.month || '本月'}）：`)
        for (const item of items) {
          const icon = item.status === 'over' ? '🔴' : item.status === 'warning' ? '🟡' : '🟢'
          const name = item.category === 'total' ? '总预算' : item.category
          parts.push(`${icon} ${name}：${item.spent}/${item.budget} 元（${item.percent}%）`)
        }
        if (summary.overCount > 0) {
          parts.push(`⚠️ 已有 ${summary.overCount} 项超支，建议控制${budgetCalc.overCategories.join('、')}类消费`)
        } else if (summary.warningCount > 0) {
          parts.push(`⚡ ${summary.warningCount} 项接近预警，留意${budgetCalc.warningCategories.join('、')}类支出`)
        } else {
          parts.push('✅ 预算执行良好，继续保持！')
        }
      }
      break
    }

    case TASK_PATTERNS.PERIOD_COMPARISON: {
      const comp = results.calc_comparison?.data
      if (comp) {
        const arrow = comp.isIncrease ? '📈' : comp.isDecrease ? '📉' : '➡️'
        parts.push(`${arrow} ${comp.comparisonType}对比：`)
        parts.push(`本月：${comp.current.total.toFixed(2)} 元（${comp.current.count} 笔）`)
        parts.push(`上月：${comp.previous.total.toFixed(2)} 元（${comp.previous.count} 笔）`)
        const diffText = comp.isIncrease ? '增加' : comp.isDecrease ? '减少' : '持平'
        parts.push(`差额：${Math.abs(comp.diff.amount).toFixed(2)} 元（${comp.diff.percent > 0 ? '+' : ''}${comp.diff.percent}%）`)
      }
      break
    }

    case TASK_PATTERNS.CATEGORY_ANALYSIS: {
      const ratio = results.calc_category_ratio?.data
      if (ratio?.ranked?.length) {
        parts.push(`📂 消费分类（总计 ${ratio.totalAmount.toFixed(2)} 元）：`)
        for (const item of ratio.ranked.slice(0, 5)) {
          parts.push(`  ${item.category}：${item.amount.toFixed(2)} 元（${item.ratio}%）`)
        }
        if (ratio.topCategory) {
          parts.push(`🏆 最大支出：${ratio.topCategory.category}（${ratio.topCategory.ratio}%）`)
        }
      }
      break
    }

    case TASK_PATTERNS.COMPREHENSIVE_ANALYSIS: {
      // 消费汇总
      const summary = results.retrieve_summary?.data
      if (summary?.count > 0) {
        parts.push(`📊 本月消费：${summary.total.toFixed(2)} 元 / ${summary.count} 笔`)
      }

      // 预算执行
      const budgetCalc = results.calc_budget?.data
      if (budgetCalc?.summary) {
        if (budgetCalc.summary.overCount > 0) {
          parts.push(`🔴 预算：${budgetCalc.summary.overCount} 项超支`)
        } else if (budgetCalc.summary.warningCount > 0) {
          parts.push(`🟡 预算：${budgetCalc.summary.warningCount} 项预警`)
        } else {
          parts.push('🟢 预算：全部正常')
        }
      }

      // 分类 TOP3
      const catCalc = results.calc_categories?.data
      if (catCalc?.ranked?.length) {
        const top3 = catCalc.ranked.slice(0, 3).map(r => r.category).join('、')
        parts.push(`📂 TOP3 分类：${top3}`)
      }
      break
    }

    case TASK_PATTERNS.PROFESSIONAL_ADVICE: {
      const analystResult = results.analyst_report?.data
      if (analystResult?.analysis) {
        parts.push('👨‍💼 您的私人财务分析师为您生成报告：')
        parts.push('')
        parts.push(analystResult.analysis)
        parts.push('')

        // 风险等级提示
        const riskIcons = { high: '🔴', medium: '🟡', low: '🟢' }
        const riskLabels = { high: '高风险', medium: '中风险', low: '低风险' }
        const risk = analystResult.riskLevel || 'low'
        parts.push(`${riskIcons[risk] || '📌'} 建议风险等级：${riskLabels[risk] || risk}`)
      } else {
        // 降级：展示结构化数据
        const summary = results.retrieve_summary?.data
        if (summary?.count > 0) {
          parts.push(`📊 本月消费：${summary.total.toFixed(2)} 元 / ${summary.count} 笔`)
        }
        const budgetCalc = results.calc_budget?.data
        if (budgetCalc?.summary) {
          const status = budgetCalc.summary.overCount > 0 ? '超支' : budgetCalc.summary.warningCount > 0 ? '预警' : '正常'
          parts.push(`💰 预算执行：${status}`)
        }
        parts.push('💡 AI 分析师暂时离线，为您展示基础数据。')
      }
      break
    }

    case TASK_PATTERNS.FAMILY_PLANNING: {
      const cfpResult = results.cfp_full_plan?.data
      if (cfpResult?.analysis) {
        parts.push('👔 CFP™ 国际金融理财师为您出具家庭财务规划方案')
        parts.push('━━━━━━━━━━━━━━━━━━━━━━')
        parts.push('')
        parts.push(cfpResult.analysis)
        parts.push('')
        parts.push('━━━━━━━━━━━━━━━━━━━━━━')
        parts.push('📌 本方案由 AI 理财顾问生成，仅供参考，不构成专业理财建议。')
        parts.push('📌 重大财务决策建议咨询持牌 CFP 理财师或专业金融顾问。')
      } else {
        // 降级展示
        const summary = results.retrieve_summary?.data
        if (summary?.count > 0) {
          parts.push(`📊 月度支出：${summary.total.toFixed(2)} 元`)
        }
        parts.push('💡 CFP 理财顾问暂时离线，建议稍后再试获取完整规划方案。')
      }
      break
    }
  }

  return {
    answer: parts.join('\n'),
    parts,
    pattern,
    rawResults: results
  }
}

// ---- 主控入口 ----

/**
 * 处理用户提问（极简 3 Agent 主入口）
 * @param {Object} options
 * @param {string} options.userId - 用户 ID
 * @param {string} options.message - 用户消息
 * @param {Object} options.hints - 查询提示（可选）
 * @returns {Promise<Object>} 处理结果
 */
async function processQuery({ userId, message, hints = {} }) {
  if (!userId) {
    return { success: false, error: '缺少 userId', answer: '请先登录后使用查询功能。' }
  }

  if (!message) {
    return { success: false, error: '消息不能为空', answer: '请问有什么可以帮您？' }
  }

  // 1. 识别任务模式
  const pattern = detectTaskPattern(message)

  // 2. 生成任务计划
  const plan = buildTaskPlan({ pattern, userId, message, hints })
  if (!plan) {
    return { success: false, error: '无法生成任务计划', answer: '抱歉，暂时无法处理这个问题。' }
  }

  // 3. 执行计划（主从协同）
  const executionResult = await executePlan({ plan, userId })

  // 4. 汇总生成回答
  const synthesis = synthesizeAnswer({ executionResult, message })

  return {
    success: true,
    pattern,
    answer: synthesis.answer,
    parts: synthesis.parts,
    execution: {
      stepCount: executionResult.stepCount,
      succeededCount: executionResult.succeededCount,
      failedCount: executionResult.failedCount
    },
    rawResults: executionResult.results
  }
}

export {
  TASK_PATTERNS,
  detectTaskPattern,
  buildTaskPlan,
  executePlan,
  synthesizeAnswer,
  processQuery
}

export default { processQuery, TASK_PATTERNS }
