/**
 * 财务分析师 Agent - 专职生成专业财务分析与个性化建议
 *
 * 定位：4 Agent 架构中的"智囊"角色，位于链路末端
 *   主控 → 检索 → 计算 → 【财务分析师】→ 最终输出
 *
 * 职责：
 * 1. 消费结构健康度分析
 * 2. 预算执行诊断与归因
 * 3. 个性化省钱建议生成
 * 4. 月度财务健康报告
 * 5. 储蓄目标可达性评估
 *
 * 输入：结构化数据（来自检索 Agent + 计算 Agent）
 * 输出：专业分析 + 可操作建议 + 风险等级
 */

import defaultLmStudioClient from './lmStudioClient.js'
import { assessRiskLevel } from './adviceReview.js'

// ---- 分析类型定义 ----

const ANALYSIS_TYPES = {
  BUDGET_DIAGNOSIS: 'budget_diagnosis',       // 预算诊断
  SPENDING_STRUCTURE: 'spending_structure',   // 消费结构分析
  MONTHLY_REPORT: 'monthly_report',           // 月度财务报告
  SAVING_PLAN: 'saving_plan',                 // 储蓄规划建议
  HEALTH_SCORE: 'health_score'                // 财务健康评分
}

// ---- System Prompt 模板 ----

const ANALYST_SYSTEM_PROMPT = `你是一位专业的个人财务分析师，化身为用户的私人理财助理。

你的工作原则：
1. 基于提供的真实记账数据进行分析，不得编造不存在的数据
2. 建议要具体、可执行，避免空泛的"理性消费"类套话
3. 语气专业但友好，像一位贴心的财务顾问
4. 重点指出问题，但也要肯定做得好的地方
5. 不推荐具体股票、基金等投资产品，只做消费层面的分析建议
6. 每条建议控制在 1-2 句话，清晰 actionable

输出格式要求：
- 先给出核心结论（1-2句话）
- 然后分点列出 3-5 条具体建议
- 最后给出一个财务健康评分（0-100分）和简短评语`

// ---- 1. 预算诊断分析 ----

async function analyzeBudget({ budgetExecution, categoryStats, lmClient = defaultLmStudioClient }) {
  if (!budgetExecution || !budgetExecution.items?.length) {
    return {
      success: false,
      error: '缺少预算执行数据',
      data: null
    }
  }

  // 组装上下文数据
  const dataContext = buildBudgetContext(budgetExecution, categoryStats)

  const userPrompt = `请基于以下用户的本月预算执行情况，给出专业的预算诊断和优化建议：

【预算执行概况】
总预算：${budgetExecution.summary?.totalBudget?.toFixed(2) || '未设置'} 元
实际支出：${budgetExecution.summary?.totalSpending?.toFixed(2) || 0} 元
超支项目：${budgetExecution.overCategories?.join('、') || '无'}
预警项目：${budgetExecution.warningCategories?.join('、') || '无'}

【各项预算明细】
${budgetExecution.items?.map(item => {
    const statusText = item.status === 'over' ? '超支' : item.status === 'warning' ? '预警' : '正常'
    const name = item.category === 'total' ? '总预算' : item.category
    return `- ${name}：${item.spent.toFixed(2)}/${item.budget.toFixed(2)} 元 (${item.percent}%) - ${statusText}`
  }).join('\n')}

${dataContext}

请给出预算诊断报告，指出超支/预警的可能原因，并给出具体的优化建议。`

  try {
    const analysis = await callLLM(lmClient, ANALYST_SYSTEM_PROMPT, userPrompt)
    const riskLevel = assessRiskLevel(analysis)

    return {
      success: true,
      type: ANALYSIS_TYPES.BUDGET_DIAGNOSIS,
      data: {
        analysis,
        riskLevel,
        summary: {
          overCount: budgetExecution.summary?.overCount || 0,
          warningCount: budgetExecution.summary?.warningCount || 0,
          healthyCount: budgetExecution.summary?.healthyCount || 0
        }
      }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 2. 消费结构分析 ----

async function analyzeStructure({ categoryRatio, month = null, lmClient = defaultLmStudioClient }) {
  if (!categoryRatio?.ranked?.length) {
    return { success: false, error: '缺少分类消费数据', data: null }
  }

  const userPrompt = `请基于以下用户的消费分类数据，进行消费结构健康度分析：

【分析周期】${month || '本月'}

【消费分类占比】
${categoryRatio.ranked.map(item =>
  `- ${item.category}：${item.amount.toFixed(2)} 元，占比 ${item.ratio}%`
).join('\n')}

【消费结构概览】
- 总支出：${categoryRatio.totalAmount?.toFixed(2) || 0} 元
- 必需消费占比：${categoryRatio.structure?.essentialRatio || 0}%
- 非必需消费占比：${categoryRatio.structure?.nonEssentialRatio || 0}%
- 消费分类数：${categoryRatio.categoryCount || 0} 个

请评估用户的消费结构是否健康，指出哪些分类偏高/偏低，给出优化方向和具体建议。`

  try {
    const analysis = await callLLM(lmClient, ANALYST_SYSTEM_PROMPT, userPrompt)
    const riskLevel = assessRiskLevel(analysis)

    return {
      success: true,
      type: ANALYSIS_TYPES.SPENDING_STRUCTURE,
      data: { analysis, riskLevel, month }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 3. 月度综合财务报告 ----

async function generateMonthlyReport({
  summary,
  budgetExecution,
  categoryRatio,
  periodComparison = null,
  month = null,
  lmClient = defaultLmStudioClient
}) {
  const hasData = summary || budgetExecution || categoryRatio
  if (!hasData) {
    return { success: false, error: '缺少月度数据', data: null }
  }

  const sections = []

  if (summary) {
    sections.push(`【本月消费概况】
- 总支出：${summary.total?.toFixed(2) || 0} 元
- 记账笔数：${summary.count || 0} 笔
- 单笔均值：${summary.average?.toFixed(2) || 0} 元`)
  }

  if (periodComparison) {
    const diffText = periodComparison.isIncrease ? '增加' : periodComparison.isDecrease ? '减少' : '持平'
    sections.push(`【环比对比】
较上月${diffText} ${Math.abs(periodComparison.diff?.amount || 0).toFixed(2)} 元（${periodComparison.diff?.percent || 0}%）`)
  }

  if (categoryRatio?.ranked?.length) {
    const top3 = categoryRatio.ranked.slice(0, 3)
    sections.push(`【TOP3 支出分类】
${top3.map((c, i) => `${i + 1}. ${c.category}：${c.amount.toFixed(2)} 元 (${c.ratio}%)`).join('\n')}`)
  }

  if (budgetExecution?.summary) {
    sections.push(`【预算执行】
超支 ${budgetExecution.summary.overCount} 项，预警 ${budgetExecution.summary.warningCount} 项，正常 ${budgetExecution.summary.healthyCount} 项`)
  }

  const userPrompt = `请为用户生成一份专业的月度财务健康报告。

${sections.join('\n\n')}

请按照以下结构输出：
1. 本月财务总结论（1段话，整体评价）
2. 亮点与问题（分点列出做得好的地方和需要注意的地方）
3. 下月行动建议（3-5条具体可执行的建议）
4. 财务健康评分（0-100分）+ 简短评语`

  try {
    const analysis = await callLLM(lmClient, ANALYST_SYSTEM_PROMPT, userPrompt)
    const riskLevel = assessRiskLevel(analysis)

    return {
      success: true,
      type: ANALYSIS_TYPES.MONTHLY_REPORT,
      data: { analysis, riskLevel, month }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 4. 储蓄规划建议 ----

async function generateSavingPlan({
  summary,
  goals = [],
  month = null,
  lmClient = defaultLmStudioClient
}) {
  const userPrompt = `请基于用户的收支情况，给出储蓄规划建议。

【当前月均支出】${summary?.total?.toFixed(2) || '未知'} 元
【记账笔数】${summary?.count || 0} 笔

${goals.length > 0 ? `【储蓄目标】\n${goals.map(g => `- ${g.name}：${g.targetAmount} 元，截止 ${g.deadline || '未定'}`).join('\n')}` : ''}

请分析用户的储蓄潜力，给出具体的储蓄方案和节流建议。如果有储蓄目标，请评估可达性并给出每月储蓄建议。`

  try {
    const analysis = await callLLM(lmClient, ANALYST_SYSTEM_PROMPT, userPrompt)
    const riskLevel = assessRiskLevel(analysis)

    return {
      success: true,
      type: ANALYSIS_TYPES.SAVING_PLAN,
      data: { analysis, riskLevel, month }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 工具函数：调用 LLM ----

async function callLLM(lmClient, systemPrompt, userPrompt) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]
  return lmClient.chat(messages)
}

// ---- 工具函数：组装预算上下文 ----

function buildBudgetContext(budgetExecution, categoryStats) {
  if (!categoryStats?.length) return ''

  const overCategories = budgetExecution.overCategories || []
  if (overCategories.length === 0) return ''

  const details = categoryStats
    .filter(s => overCategories.includes(s.category))
    .map(s => `${s.category}：${s.total?.toFixed(2)} 元，共 ${s.count} 笔`)

  if (details.length === 0) return ''

  return `\n【超支分类详情】\n${details.join('\n')}`
}

// ---- 统一调度入口 ----

/**
 * 执行财务分析任务
 * @param {Object} task - 分析任务描述
 * @param {string} task.type - 分析类型
 * @param {Object} task.params - 分析参数（结构化数据，来自检索+计算Agent）
 */
async function execute(task) {
  const { type, params = {} } = task || {}

  const handlers = {
    [ANALYSIS_TYPES.BUDGET_DIAGNOSIS]: () => analyzeBudget(params),
    [ANALYSIS_TYPES.SPENDING_STRUCTURE]: () => analyzeStructure(params),
    [ANALYSIS_TYPES.MONTHLY_REPORT]: () => generateMonthlyReport(params),
    [ANALYSIS_TYPES.SAVING_PLAN]: () => generateSavingPlan(params)
  }

  const handler = handlers[type]
  if (!handler) {
    return { success: false, error: `未知分析类型: ${type}`, agent: 'analyst' }
  }

  try {
    const result = await handler()
    return { ...result, agent: 'analyst', taskType: type }
  } catch (error) {
    return { success: false, error: error.message, agent: 'analyst', taskType: type }
  }
}

export {
  ANALYSIS_TYPES,
  analyzeBudget,
  analyzeStructure,
  generateMonthlyReport,
  generateSavingPlan,
  execute
}

export default { execute, ANALYSIS_TYPES }
