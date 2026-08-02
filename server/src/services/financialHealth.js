/**
 * 财务健康评估引擎 — 从原始消费数据计算多维度健康指标
 *
 * 指标维度:
 * - 储蓄率 (savingsRate)
 * - 收支平衡 (incomeExpenseRatio)
 * - 预算执行 (budgetAdherence)
 * - 消费集中度 (spendingConcentration)
 * - 月度趋势 (monthlyTrend)
 * - 应急基金 (emergencyFundMonths)
 * - 财务健康分 (healthScore: 0-100)
 */

/**
 * @typedef {Object} FinancialSnapshot
 * @property {number} totalIncome - 总收入
 * @property {number} totalExpense - 总支出
 * @property {Object[]} categoryBreakdown - 分类明细
 * @property {Object[]} budgets - 预算数据
 * @property {number} monthCount - 数据月数
 */

/**
 * 计算储蓄率 (0-100%)
 */
function savingsRate(income, expense) {
  if (income <= 0) return 0
  return Math.max(0, Math.min(100, ((income - expense) / income) * 100))
}

/**
 * 计算预算执行率 (0-100%，>100 表示超支)
 */
function budgetAdherence(spent, limit) {
  if (limit <= 0) return 100
  return Math.round((spent / limit) * 100)
}

/**
 * 预算状态标记
 */
function budgetStatus(adherence) {
  if (adherence >= 100) return { level: 'over', label: '超支', color: 'red' }
  if (adherence >= 80) return { level: 'warning', label: '接近上限', color: 'orange' }
  if (adherence >= 50) return { level: 'normal', label: '正常', color: 'green' }
  return { level: 'under', label: '远低于预算', color: 'blue' }
}

/**
 * 消费集中度 — 前 N 个分类占总消费的比例
 */
function spendingConcentration(breakdown) {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return { topCategory: null, top3Ratio: 0, diversity: 'unknown' }
  const sorted = [...breakdown].sort((a, b) => (b.total || 0) - (a.total || 0))
  const total = sorted.reduce((s, c) => s + (c.total || 0), 0)
  if (total === 0) return { topCategory: null, top3Ratio: 0, diversity: 'unknown' }

  const top3 = sorted.slice(0, 3).reduce((s, c) => s + (c.total || 0), 0)
  const ratio = top3 / total

  return {
    topCategory: sorted[0]?.category || '未知',
    topCategoryRatio: sorted[0] ? Math.round((sorted[0].total / total) * 100) : 0,
    top3Ratio: Math.round(ratio * 100),
    diversity: ratio > 0.8 ? '集中' : ratio > 0.5 ? '中等' : '分散'
  }
}

/**
 * 月度趋势 — 简单的环比变化
 */
function monthlyTrend(current, previous) {
  if (!previous || previous.total <= 0) return { direction: 'flat', changePercent: 0 }
  const change = ((current.total - previous.total) / previous.total) * 100
  return {
    direction: change > 5 ? 'up' : change < -5 ? 'down' : 'flat',
    changePercent: Math.round(change)
  }
}

/**
 * 财务健康评分 (0-100)
 *
 * 评分维度:
 * - 储蓄率 (30分): >=30% → 30分, >=10% → 20分, >0 → 10分
 * - 预算执行 (25分): 无超支 → 25分, 轻微超支 → 15分, 严重超支 → 5分
 * - 消费多样性 (20分): 分散 → 20分, 中等 → 12分, 集中 → 5分
 * - 数据完整性 (15分): >=3个月 → 15分, >=1个月 → 8分
 * - 应急基金 (10分): >=3个月 → 10分, >=1个月 → 5分
 */
function computeHealthScore({ savingsRate, budgetAdherence, concentration, monthCount, emergencyFundMonths }) {
  let score = 0

  // 储蓄率
  if (savingsRate >= 30) score += 30
  else if (savingsRate >= 10) score += 20
  else if (savingsRate > 0) score += 10

  // 预算执行（取最差分类）
  if (budgetAdherence) {
    const worst = Math.max(...Object.values(budgetAdherence))
    if (worst <= 100) score += 25
    else if (worst <= 120) score += 15
    else score += 5
  }

  // 消费多样性
  if (concentration?.diversity === '分散') score += 20
  else if (concentration?.diversity === '中等') score += 12
  else score += 5

  // 数据完整性
  if (monthCount >= 3) score += 15
  else if (monthCount >= 1) score += 8

  // 应急基金
  if (emergencyFundMonths >= 3) score += 10
  else if (emergencyFundMonths >= 1) score += 5

  return score
}

/**
 * 生成财务洞察 (基于规则，不依赖 LLM)
 */
function generateInsights(snapshot) {
  const insights = []
  const { totalIncome, totalExpense, categoryBreakdown, budgets } = snapshot

  const rate = savingsRate(totalIncome, totalExpense)

  // 储蓄率洞察
  if (rate >= 30) {
    insights.push({ type: 'positive', category: 'savings', message: `储蓄率 ${rate.toFixed(0)}%，财务状况健康` })
  } else if (rate >= 10) {
    insights.push({ type: 'neutral', category: 'savings', message: `储蓄率 ${rate.toFixed(0)}%，建议提升至 20% 以上` })
  } else if (totalIncome > 0) {
    insights.push({ type: 'warning', category: 'savings', message: `储蓄率仅 ${rate.toFixed(0)}%，建议审视非必要支出` })
  }

  // 预算洞察
  if (budgets && Array.isArray(budgets)) {
    for (const budget of budgets) {
      const adherence = budgetAdherence(budget.spent || 0, budget.limit || 0)
      const status = budgetStatus(adherence)
      if (status.level === 'over') {
        insights.push({
          type: 'warning',
          category: 'budget',
          message: `${budget.category || '预算'} 已超支 (${adherence}%)，已用 ${budget.spent} / ${budget.limit}`
        })
      } else if (status.level === 'warning') {
        insights.push({
          type: 'neutral',
          category: 'budget',
          message: `${budget.category || '预算'} 接近上限 (${adherence}%)`
        })
      }
    }
  }

  // 消费集中度
  const concentration = spendingConcentration(categoryBreakdown)
  if (concentration.top3Ratio >= 80) {
    insights.push({
      type: 'info',
      category: 'diversity',
      message: `消费集中在 ${concentration.topCategory} 等少数分类（前3占 ${concentration.top3Ratio}%），建议分散消费结构`
    })
  }

  return { insights, healthScore: computeHealthScore({
    savingsRate: rate,
    budgetAdherence: budgets?.reduce((acc, b) => {
      acc[b.category || 'other'] = budgetAdherence(b.spent || 0, b.limit || 0)
      return acc
    }, {}) || {},
    concentration,
    monthCount: snapshot.monthCount || 1,
    emergencyFundMonths: snapshot.emergencyFundMonths || 0
  }) }
}

/**
 * 主入口：全面财务健康检查
 *
 * @param {FinancialSnapshot} snapshot
 * @returns {Object} 完整的健康报告
 */
export function analyzeFinancialHealth(snapshot) {
  const { totalIncome = 0, totalExpense = 0, categoryBreakdown = [], budgets = [], monthCount = 1 } = snapshot

  const rate = savingsRate(totalIncome, totalExpense)
  const concentration = spendingConcentration(categoryBreakdown)
  const budgetResults = budgets.map(b => ({
    category: b.category || '其他',
    limit: b.limit || 0,
    spent: b.spent || 0,
    remaining: (b.limit || 0) - (b.spent || 0),
    adherence: budgetAdherence(b.spent || 0, b.limit || 0),
    status: budgetStatus(budgetAdherence(b.spent || 0, b.limit || 0))
  }))

  const emergencyFundMonths = totalExpense > 0
    ? Math.round((snapshot.totalSavings || 0) / (totalExpense / Math.max(monthCount, 1)) * 10) / 10
    : 0

  const { insights, healthScore } = generateInsights(snapshot)

  return {
    summary: {
      totalIncome,
      totalExpense,
      netCashflow: totalIncome - totalExpense,
      savingsRate: Math.round(rate),
      healthScore,
      healthLabel: healthScore >= 80 ? '优秀' : healthScore >= 60 ? '良好' : healthScore >= 40 ? '一般' : '需关注',
      emergencyFundMonths,
      monthCount
    },
    budgets: budgetResults,
    concentration,
    insights,
    // 财务建议（基于规则，非投资建议）
    recommendations: generateRecommendations({ savingsRate: rate, healthScore, concentration, budgetResults })
  }
}

/**
 * 基于财务指标的通用建议 (不涉及具体投资产品)
 */
function generateRecommendations({ savingsRate, healthScore, concentration, budgetResults }) {
  const recs = []

  if (savingsRate < 20) {
    recs.push({ priority: 'high', area: 'savings', suggestion: '建议将储蓄率提升至 20% 以上，可通过减少非必要消费或增加收入实现' })
  }

  const overspent = budgetResults?.filter(b => b.adherence >= 100) || []
  if (overspent.length > 0) {
    recs.push({
      priority: 'high',
      area: 'budget',
      suggestion: `${overspent.map(b => b.category).join('、')} 分类超预算，建议调整预算额度或控制支出`
    })
  }

  if (concentration?.top3Ratio >= 80) {
    recs.push({ priority: 'medium', area: 'diversity', suggestion: '消费过于集中，建议审视是否有可优化的支出结构' })
  }

  if (healthScore < 60) {
    recs.push({ priority: 'high', area: 'overall', suggestion: '整体财务健康度偏低，建议制定月度预算并坚持记录每一笔支出' })
  }

  return recs
}

export default { analyzeFinancialHealth }
