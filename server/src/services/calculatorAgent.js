/**
 * 计算 Agent - 专职执行财务运算、指标计算与合规校验
 *
 * 职责：
 * 1. 预算执行计算 - 超支预警、剩余预算计算
 * 2. 财务指标计算 - 环比、同比、占比、平均值
 * 3. 合规校验 - 金额合理性、预算合规性检查
 * 4. 趋势分析 - 消费趋势、分类趋势计算
 *
 * 输入：来自检索 Agent 的原始数据
 * 输出：计算后的结构化指标与判断结果
 */

// ---- 计算类型定义 ----

const CALCULATION_TYPES = {
  BUDGET_EXECUTION: 'budget_execution',     // 预算执行计算
  PERIOD_COMPARISON: 'period_comparison',   // 周期对比计算（环比/同比）
  COMPLIANCE_CHECK: 'compliance_check',     // 合规校验
  CATEGORY_RATIO: 'category_ratio',         // 分类占比分析
  SPENDING_TREND: 'spending_trend'          // 消费趋势计算
}

// ---- 1. 预算执行计算 ----

/**
 * 计算预算执行情况
 * @param {Object} params
 * @param {Array}  params.budgets - 预算配置列表（来自检索 Agent）
 * @param {Array}  params.categoryStats - 分类消费统计（来自检索 Agent）
 * @param {number} params.totalSpending - 总消费金额
 * @param {string} params.month - 月份
 */
function calculateBudgetExecution({ budgets = [], categoryStats = [], totalSpending = 0, month = null }) {
  const results = []

  // 分类预算计算
  for (const budget of budgets) {
    const cat = budget.category || 'total'
    let spent = 0

    if (cat === 'total') {
      spent = totalSpending
    } else {
      const stat = categoryStats.find(s => s.category === cat)
      spent = stat?.total || 0
    }

    const budgetAmount = Number(budget.amount || 0)
    const remaining = budgetAmount - spent
    const percent = budgetAmount > 0 ? Math.round((spent / budgetAmount) * 100) : 0

    let status = 'ok'
    if (percent >= 100) status = 'over'
    else if (percent >= 80) status = 'warning'

    results.push({
      category: cat,
      budget: budgetAmount,
      spent: Number(spent.toFixed(2)),
      remaining: Number(remaining.toFixed(2)),
      percent,
      status,
      overAmount: status === 'over' ? Number((spent - budgetAmount).toFixed(2)) : 0
    })
  }

  // 汇总指标
  const totalBudget = budgets
    .filter(b => (b.category || 'total') === 'total')
    .reduce((sum, b) => sum + Number(b.amount || 0), 0)

  const overBudgets = results.filter(r => r.status === 'over')
  const warningBudgets = results.filter(r => r.status === 'warning')

  return {
    success: true,
    type: CALCULATION_TYPES.BUDGET_EXECUTION,
    data: {
      items: results,
      summary: {
        totalBudget,
        totalSpending: Number(totalSpending.toFixed(2)),
        budgetCount: results.length,
        overCount: overBudgets.length,
        warningCount: warningBudgets.length,
        healthyCount: results.filter(r => r.status === 'ok').length
      },
      overCategories: overBudgets.map(b => b.category),
      warningCategories: warningBudgets.map(b => b.category),
      month
    }
  }
}

// ---- 2. 周期对比计算（环比/同比）----

/**
 * 计算两个周期的对比指标
 * @param {Object} params
 * @param {Object} params.current - 当前周期数据 { total, count }
 * @param {Object} params.previous - 对比周期数据 { total, count }
 * @param {string} params.periodLabel - 周期标签（如"本月"、"上月"）
 */
function calculatePeriodComparison({ current, previous, periodLabel = '环比' }) {
  const currTotal = Number(current?.total || 0)
  const prevTotal = Number(previous?.total || 0)
  const currCount = Number(current?.count || 0)
  const prevCount = Number(previous?.count || 0)

  const diffAmount = Number((currTotal - prevTotal).toFixed(2))
  const diffPercent = prevTotal > 0
    ? Math.round((diffAmount / prevTotal) * 100)
    : (currTotal > 0 ? 100 : 0)

  const countDiff = currCount - prevCount
  const countDiffPercent = prevCount > 0
    ? Math.round((countDiff / prevCount) * 100)
    : (currCount > 0 ? 100 : 0)

  let trend = 'flat'
  if (diffPercent > 5) trend = 'up'
  else if (diffPercent < -5) trend = 'down'

  return {
    success: true,
    type: CALCULATION_TYPES.PERIOD_COMPARISON,
    data: {
      comparisonType: periodLabel,
      current: { total: currTotal, count: currCount },
      previous: { total: prevTotal, count: prevCount },
      diff: {
        amount: diffAmount,
        percent: diffPercent,
        countDiff,
        countDiffPercent
      },
      trend,
      isIncrease: diffAmount > 0,
      isDecrease: diffAmount < 0
    }
  }
}

// ---- 3. 合规校验 ----

/**
 * 校验记账数据的合规性与合理性
 * @param {Object} params
 * @param {Object} params.record - 待校验的记录
 * @param {Object} params.budgetExecution - 预算执行结果（可选）
 */
function checkCompliance({ record, budgetExecution = null }) {
  const issues = []
  const warnings = []

  // 金额合理性校验
  const amount = Number(record?.amount || 0)
  if (amount <= 0) {
    issues.push({ level: 'error', code: 'INVALID_AMOUNT', message: '金额必须大于 0' })
  }
  if (amount > 100000) {
    warnings.push({ level: 'warning', code: 'LARGE_AMOUNT', message: '单笔金额较大，请确认是否正确' })
  }

  // 分类校验
  const validCategories = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '收入', '其他']
  if (record?.category && !validCategories.includes(record.category)) {
    warnings.push({ level: 'warning', code: 'UNKNOWN_CATEGORY', message: `分类「${record.category}」不在标准分类中` })
  }

  // 预算合规校验
  if (budgetExecution && record?.type === 'expense') {
    const catBudget = budgetExecution.items?.find(b => b.category === (record.category || 'total'))
    if (catBudget && catBudget.status === 'over') {
      warnings.push({
        level: 'warning',
        code: 'BUDGET_OVER',
        message: `该分类已超支 ${catBudget.overAmount} 元`
      })
    }
  }

  const passed = issues.length === 0
  const riskLevel = issues.length > 0 ? 'high' : warnings.length > 0 ? 'medium' : 'low'

  return {
    success: true,
    type: CALCULATION_TYPES.COMPLIANCE_CHECK,
    data: {
      passed,
      riskLevel,
      issues,
      warnings,
      issueCount: issues.length,
      warningCount: warnings.length
    }
  }
}

// ---- 4. 分类占比分析 ----

/**
 * 计算消费分类占比与健康度评估
 * @param {Object} params
 * @param {Array}  params.categoryStats - 分类统计（来自检索 Agent）
 */
function calculateCategoryRatio({ categoryStats = [] }) {
  const total = categoryStats.reduce((sum, s) => sum + Number(s.total || 0), 0)

  const ranked = categoryStats
    .map(s => ({
      category: s.category,
      amount: Number(s.total || 0),
      count: Number(s.count || 0),
      ratio: total > 0 ? Number(((s.total / total) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.amount - a.amount)

  const topCategory = ranked[0] || null

  // 简单的消费结构评估
  const essentialCategories = ['餐饮', '交通', '住房', '医疗', '通讯']
  const essentialAmount = ranked
    .filter(r => essentialCategories.includes(r.category))
    .reduce((sum, r) => sum + r.amount, 0)
  const essentialRatio = total > 0 ? Math.round((essentialAmount / total) * 100) : 0

  return {
    success: true,
    type: CALCULATION_TYPES.CATEGORY_RATIO,
    data: {
      totalAmount: Number(total.toFixed(2)),
      ranked,
      topCategory,
      categoryCount: ranked.length,
      structure: {
        essentialAmount: Number(essentialAmount.toFixed(2)),
        essentialRatio,
        nonEssentialRatio: 100 - essentialRatio
      }
    }
  }
}

// ---- 5. 消费趋势计算 ----

/**
 * 计算简单消费趋势（基于多日/多月数据）
 * @param {Object} params
 * @param {Array}  params.dataPoints - 数据点 [{ period, total, count }]
 */
function calculateSpendingTrend({ dataPoints = [] }) {
  if (dataPoints.length < 2) {
    return {
      success: true,
      type: CALCULATION_TYPES.SPENDING_TREND,
      data: { trend: 'insufficient_data', dataPoints, slope: 0 }
    }
  }

  const sorted = [...dataPoints].sort((a, b) => a.period.localeCompare(b.period))
  const values = sorted.map(d => Number(d.total || 0))

  // 简单线性趋势（最小二乘斜率）
  const n = values.length
  const xMean = (n - 1) / 2
  const yMean = values.reduce((s, v) => s + v, 0) / n

  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean)
    denominator += (i - xMean) ** 2
  }
  const slope = denominator > 0 ? numerator / denominator : 0

  let trend = 'flat'
  if (slope > yMean * 0.05) trend = 'rising'
  else if (slope < -yMean * 0.05) trend = 'falling'

  return {
    success: true,
    type: CALCULATION_TYPES.SPENDING_TREND,
    data: {
      trend,
      slope: Number(slope.toFixed(2)),
      average: Number(yMean.toFixed(2)),
      dataPoints: sorted,
      isRising: trend === 'rising',
      isFalling: trend === 'falling'
    }
  }
}

// ---- 统一调度入口 ----

/**
 * 执行计算任务
 * @param {Object} task - 计算任务描述
 * @param {string} task.type - 计算类型
 * @param {Object} task.params - 计算参数（原始数据，通常来自检索 Agent）
 */
async function execute(task) {
  const { type, params = {} } = task || {}

  const handlers = {
    [CALCULATION_TYPES.BUDGET_EXECUTION]: () => calculateBudgetExecution(params),
    [CALCULATION_TYPES.PERIOD_COMPARISON]: () => calculatePeriodComparison(params),
    [CALCULATION_TYPES.COMPLIANCE_CHECK]: () => checkCompliance(params),
    [CALCULATION_TYPES.CATEGORY_RATIO]: () => calculateCategoryRatio(params),
    [CALCULATION_TYPES.SPENDING_TREND]: () => calculateSpendingTrend(params)
  }

  const handler = handlers[type]
  if (!handler) {
    return { success: false, error: `未知计算类型: ${type}`, agent: 'calculator' }
  }

  try {
    const result = handler()
    return { ...result, agent: 'calculator', taskType: type }
  } catch (error) {
    return { success: false, error: error.message, agent: 'calculator', taskType: type }
  }
}

export {
  CALCULATION_TYPES,
  calculateBudgetExecution,
  calculatePeriodComparison,
  checkCompliance,
  calculateCategoryRatio,
  calculateSpendingTrend,
  execute
}

export default { execute, CALCULATION_TYPES }
