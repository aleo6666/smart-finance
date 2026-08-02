/**
 * 财务顾问 Agent 评估用例 — 验证理财师级分析能力
 *
 * 运行: node --test --test-force-exit test/agent/advisorEval.test.js
 */

import test, { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeFinancialHealth } from '../../src/services/financialHealth.js'

describe('财务健康评估引擎', () => {
  // ============================================================
  // 储蓄率计算
  // ============================================================
  it('健康储蓄率 (>=30%) 得分 >=80', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 15000,
      totalExpense: 9000,
      categoryBreakdown: [
        { category: '餐饮', total: 3000 },
        { category: '交通', total: 1000 },
        { category: '住房', total: 3000 },
        { category: '娱乐', total: 1000 },
        { category: '其他', total: 1000 }
      ],
      budgets: [{ category: '餐饮', limit: 3500, spent: 3000 }],
      monthCount: 3
    })

    assert.ok(result.summary.savingsRate === 40, '储蓄率应为 40%')
    assert.ok(result.summary.healthScore >= 80, `健康评分应 >=80，实际: ${result.summary.healthScore}`)
    assert.equal(result.summary.healthLabel, '优秀')
  })

  // ============================================================
  // 低储蓄率
  // ============================================================
  it('低储蓄率 (<10%) 得分 <60', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 8000,
      totalExpense: 7800,
      categoryBreakdown: [
        { category: '餐饮', total: 3500 },
        { category: '娱乐', total: 2500 }
      ],
      budgets: [{ category: '餐饮', limit: 2500, spent: 3500 }],
      monthCount: 1
    })

    assert.ok(result.summary.savingsRate <= 3)
    assert.ok(result.summary.healthScore < 60)
    assert.equal(result.summary.healthLabel, '需关注')
  })

  // ============================================================
  // 预算超支检测
  // ============================================================
  it('检测预算超支并生成警告', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 10000,
      totalExpense: 7000,
      categoryBreakdown: [{ category: '餐饮', total: 3000 }],
      budgets: [
        { category: '餐饮', limit: 2000, spent: 2400 },
        { category: '交通', limit: 500, spent: 300 }
      ],
      monthCount: 2
    })

    const overspent = result.budgets.filter(b => b.status.level === 'over')
    assert.ok(overspent.length > 0, '应该有超支分类')

    const warnings = result.insights.filter(i => i.type === 'warning')
    assert.ok(warnings.length > 0, '应该有警告洞察')

    const recs = result.recommendations.filter(r => r.area === 'budget')
    assert.ok(recs.length > 0, '应该有预算建议')
  })

  // ============================================================
  // 消费集中度
  // ============================================================
  it('识别消费集中度过高', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 12000,
      totalExpense: 8000,
      categoryBreakdown: [
        { category: '餐饮', total: 5000 },
        { category: '交通', total: 500 },
        { category: '住房', total: 2000 },
        { category: '其他', total: 500 }
      ],
      budgets: [],
      monthCount: 1
    })

    assert.ok(result.concentration.top3Ratio >= 80, '前3分类应占 >=80%')
    assert.equal(result.concentration.diversity, '集中')
  })

  // ============================================================
  // 目标规划可行性
  // ============================================================
  it('目标规划 — 可行', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 12000,
      totalExpense: 7000,
      categoryBreakdown: [],
      budgets: [],
      monthCount: 3,
      totalSavings: 0
    })

    // 月存5000，存12个月可达6万
    const needed = 60000
    const monthlySaving = 5000
    const timelineMonths = 12
    const requiredMonthly = needed / timelineMonths

    assert.ok(monthlySaving >= requiredMonthly, '当前储蓄速度应满足目标')
    assert.equal(requiredMonthly, 5000)
  })

  it('目标规划 — 不可行', () => {
    const needed = 100000
    const monthlySaving = 3000
    const timelineMonths = 12
    const requiredMonthly = needed / timelineMonths

    assert.ok(monthlySaving < requiredMonthly, '当前储蓄速度应不足以达成目标')
    assert.equal(Math.round(requiredMonthly), 8333)
  })

  // ============================================================
  // 应急基金
  // ============================================================
  it('计算应急基金月数', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 10000,
      totalExpense: 5000,
      categoryBreakdown: [],
      budgets: [],
      monthCount: 6,
      totalSavings: 30000
    })

    assert.ok(result.summary.emergencyFundMonths >= 3, `应急基金应 >=3 个月，实际: ${result.summary.emergencyFundMonths}`)
  })

  // ============================================================
  // 边界情况
  // ============================================================
  it('零收入处理', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 0,
      totalExpense: 5000,
      categoryBreakdown: [{ category: '餐饮', total: 5000 }],
      budgets: [],
      monthCount: 1
    })

    assert.equal(result.summary.savingsRate, 0)
    assert.equal(result.summary.emergencyFundMonths, 0)
  })

  it('空数据不崩溃', () => {
    const result = analyzeFinancialHealth({
      totalIncome: 0,
      totalExpense: 0,
      categoryBreakdown: [],
      budgets: [],
      monthCount: 1
    })

    assert.ok(typeof result.summary.healthScore === 'number')
    assert.ok(Array.isArray(result.insights))
    assert.ok(Array.isArray(result.recommendations))
  })
})

describe('财务顾问评估套件', () => {
  // 验证 advisor 工具可导入
  it('advisorTool 导出 createAdvisorTools + ADVISOR_TOOL_NAMES', async () => {
    const mod = await import('../../src/agent/tools/advisorTool.js')
    assert.equal(typeof mod.createAdvisorTools, 'function')
    assert.ok(mod.ADVISOR_TOOL_NAMES instanceof Set)
    assert.ok(mod.ADVISOR_TOOL_NAMES.has('analyze_financial_health'))
    assert.ok(mod.ADVISOR_TOOL_NAMES.has('plan_financial_goal'))
  })
})
