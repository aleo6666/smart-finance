/**
 * CFP 国际金融理财师 Agent - 高端家庭财务规划
 *
 * 定位：5 Agent 架构中的"首席理财师"角色，面向高净值家庭
 *   主控 → 检索 → 计算 → 财务分析师 → 【CFP 理财师】
 *
 * 专业领域（CFP 七大规划）：
 * 1. 现金规划 - 收支预算、应急资金
 * 2. 负债管理 - 债务结构优化
 * 3. 风险管理与保险规划
 * 4. 投资规划 - 资产配置
 * 5. 教育金规划 - 子女教育
 * 6. 退休养老规划
 * 7. 财产分配与传承
 *
 * 设计原则：
 * - 专业严谨，符合 CFP 职业道德准则
 * - 不推荐具体股票/基金/保险产品，只给配置方向和原则
 * - 数据不足时明确说明假设，引导用户补充
 * - 所有建议附带风险提示
 */

import defaultLmStudioClient from './lmStudioClient.js'
import { assessRiskLevel } from './adviceReview.js'

// ---- 规划类型定义 ----

const PLANNING_TYPES = {
  FULL_FINANCIAL_PLAN: 'full_financial_plan',       // 完整家庭财务规划
  CASH_FLOW_PLAN: 'cash_flow_plan',                 // 现金流与预算规划
  EMERGENCY_FUND: 'emergency_fund',                 // 应急资金规划
  DEBT_MANAGEMENT: 'debt_management',               // 负债管理
  INSURANCE_PLAN: 'insurance_plan',                 // 保险规划
  INVESTMENT_ALLOCATION: 'investment_allocation',   // 投资资产配置
  RETIREMENT_PLAN: 'retirement_plan',               // 养老规划
  EDUCATION_FUND: 'education_fund'                  // 子女教育金
}

// ---- CFP 专业 System Prompt ----

const CFP_SYSTEM_PROMPT = `你是一位持牌 CFP™（国际金融理财师），担任用户的私人财富顾问，服务于高净值家庭。

【身份与立场】
- 你具备 CFP 资格认证，严格遵循 CFP 职业道德准则：正直、客观、称职、公平、保密、专业、勤勉
- 你站在客户利益至上的立场，提供客观中立的财务规划建议
- 你不代表任何金融机构，不推销任何具体产品

【专业方法论】
采用标准家庭财务规划流程：
1. 财务状况诊断 → 2. 目标明确 → 3. 方案制定 → 4. 执行建议 → 5. 定期检视

【七大规划模块】
1. 现金规划：收支储蓄分析、预算管理、应急准备金（3-6个月刚性支出）
2. 负债管理：债务结构分析、还款优先级、债务优化方案
3. 风险管理与保险：保障缺口分析、险种配置原则、保额测算方法
4. 投资规划：风险承受评估、资产配置原则、投资组合构建逻辑
5. 教育金规划：子女教育目标测算、储备策略、工具选择原则
6. 退休养老规划：养老金缺口测算、积累策略、退休收入规划
7. 财产分配与传承：家庭财产架构、传承工具选择原则

【输出规范】
1. 先给出整体财务健康评级（A/B/C/D 四级）和核心结论
2. 分模块展开分析，每个模块包含：现状评估、问题诊断、优化建议
3. 数据不足时，明确标注"【假设】"并说明基于行业通用标准推算
4. 所有投资类建议必须附带风险提示
5. 结尾给出优先级行动清单（按紧急重要排序）
6. 语言专业但易懂，避免过多术语，必要时解释

【重要红线】
- 绝对不推荐具体股票、基金、保险产品名称
- 不承诺收益率，不做保本保证
- 涉及税务、法律问题明确建议咨询专业律师/税务师
- 高风险投资建议必须强调"仅为资产配置思路，不构成投资建议"`

// ---- 1. 完整家庭财务规划 ----

async function generateFullPlan({
  summary = null,
  budgetExecution = null,
  categoryRatio = null,
  familyProfile = {},
  lmClient = defaultLmStudioClient
}) {
  const hasExpenseData = summary && summary.count > 0

  const dataSection = []

  if (hasExpenseData) {
    dataSection.push(`【月度收支概况（基于记账数据）】
- 月均支出：${summary.total?.toFixed(2) || 0} 元
- 月均记账笔数：${summary.count || 0} 笔
- 单笔均值：${summary.average?.toFixed(2) || 0} 元`)
  }

  if (categoryRatio?.ranked?.length) {
    const top3 = categoryRatio.ranked.slice(0, 3)
    dataSection.push(`【支出结构 TOP3】
${top3.map((c, i) => `${i + 1}. ${c.category}：${c.amount.toFixed(2)} 元/月 (${c.ratio}%)`).join('\n')}`)
  }

  if (budgetExecution?.summary) {
    dataSection.push(`【预算执行情况】
- 超支项目：${budgetExecution.summary.overCount || 0} 项
- 预警项目：${budgetExecution.summary.warningCount || 0} 项
- 正常项目：${budgetExecution.summary.healthyCount || 0} 项`)
  }

  // 家庭基本信息（如有）
  if (Object.keys(familyProfile).length > 0) {
    dataSection.push(`【家庭基本信息】
${Object.entries(familyProfile).map(([k, v]) => `- ${k}：${v}`).join('\n')}`)
  }

  const dataNote = hasExpenseData
    ? '以下分析基于您的记账数据进行，资产、负债、保险、投资等维度将基于行业通用标准给出框架性建议。'
    : '【重要提示】当前缺少家庭资产、负债、收入、保险等完整财务数据，以下方案基于通用家庭财务框架给出建议方向。建议您补充完整财务信息后获得精准规划。'

  const userPrompt = `请为我出具一份专业的家庭财务规划报告。

${dataSection.join('\n\n')}

${dataNote}

请按照 CFP 标准规划框架输出完整报告，包含以下模块：
1. 整体财务健康评级与核心结论
2. 现金规划与收支优化建议（含应急资金测算）
3. 负债管理建议（如无数据则给出债务管理原则）
4. 风险管理与保险配置原则（含保障缺口分析框架）
5. 投资规划与资产配置建议（含风险评估思路）
6. 教育金规划思路（如有子女）
7. 退休养老规划框架
8. 优先级行动清单（短期/中期/长期）

请保持专业严谨的理财顾问风格。`

  try {
    const analysis = await callLLM(lmClient, CFP_SYSTEM_PROMPT, userPrompt)
    const riskLevel = assessRiskLevel(analysis)

    return {
      success: true,
      type: PLANNING_TYPES.FULL_FINANCIAL_PLAN,
      data: {
        analysis,
        riskLevel,
        plannerLevel: 'CFP',
        dataCompleteness: hasExpenseData ? 'partial' : 'framework_only',
        modules: ['cash_flow', 'debt', 'insurance', 'investment', 'education', 'retirement']
      }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 2. 现金流与应急资金规划 ----

async function planCashFlow({ summary, categoryRatio = null, lmClient = defaultLmStudioClient }) {
  const monthlyExpense = summary?.total || 0

  const userPrompt = `请基于用户的支出数据，做现金规划与应急资金方案。

【月度支出数据】
- 月均总支出：${monthlyExpense.toFixed(2)} 元
- 月均记账笔数：${summary?.count || 0} 笔

${categoryRatio?.ranked?.length ? `【支出分类占比】\n${categoryRatio.ranked.slice(0, 5).map(c => `- ${c.category}：${c.ratio}%`).join('\n')}` : ''}

请输出：
1. 收支储蓄健康度评估
2. 应急资金目标测算（按3个月、6个月刚性支出分别计算）
3. 应急资金存放原则
4. 月度预算优化建议（分必需/非必需支出）
5. 储蓄率提升路径`

  try {
    const analysis = await callLLM(lmClient, CFP_SYSTEM_PROMPT, userPrompt)
    return {
      success: true,
      type: PLANNING_TYPES.CASH_FLOW_PLAN,
      data: { analysis, riskLevel: assessRiskLevel(analysis) }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 3. 保险规划 ----

async function planInsurance({ familyProfile = {}, summary = null, lmClient = defaultLmStudioClient }) {
  const annualExpense = (summary?.total || 0) * 12

  const userPrompt = `请为用户家庭做风险管理与保险规划建议。

【参考数据】
- 家庭年支出：约 ${annualExpense.toFixed(0)} 元（基于月度记账推算）
${Object.entries(familyProfile).map(([k, v]) => `- ${k}：${v}`).join('\n')}

请按照 CFP 保险规划方法论输出：
1. 家庭保障需求分析（收入损失风险、医疗风险、财产风险）
2. 险种配置原则：寿险、重疾险、医疗险、意外险、财产险的配置逻辑
3. 保额测算方法（基于家庭责任法/收入倍数法）
4. 保费预算建议（占收入比例原则）
5. 投保优先级与注意事项
6. 重要风险提示

强调：不推荐具体保险产品名称，只讲配置原则和选型逻辑。`

  try {
    const analysis = await callLLM(lmClient, CFP_SYSTEM_PROMPT, userPrompt)
    return {
      success: true,
      type: PLANNING_TYPES.INSURANCE_PLAN,
      data: { analysis, riskLevel: assessRiskLevel(analysis) }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 4. 投资资产配置 ----

async function planInvestment({ riskProfile = 'balanced', lmClient = defaultLmStudioClient }) {
  const userPrompt = `请为用户制定投资规划与资产配置建议框架。

【风险偏好】${riskProfile === 'conservative' ? '保守型' : riskProfile === 'aggressive' ? '进取型' : '稳健型'}

请输出：
1. 资产配置的核心原则（分散化、风险收益匹配、长期主义）
2. 大类资产介绍：现金类、固收类、权益类、另类资产的风险收益特征
3. 不同风险偏好的标准配置比例参考（保守/稳健/进取）
4. 定投策略与再平衡机制
5. 投资纪律与常见误区
6. 【重要风险提示】

强调：
- 不推荐具体基金、股票名称
- 所有配置比例仅为理论参考，不构成投资建议
- 明确说明投资有风险，入市需谨慎`

  try {
    const analysis = await callLLM(lmClient, CFP_SYSTEM_PROMPT, userPrompt)
    return {
      success: true,
      type: PLANNING_TYPES.INVESTMENT_ALLOCATION,
      data: { analysis, riskLevel: assessRiskLevel(analysis) }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 5. 养老规划 ----

async function planRetirement({ currentAge = null, retirementAge = 60, lmClient = defaultLmStudioClient }) {
  const userPrompt = `请为用户做退休养老规划框架。

${currentAge ? `当前年龄：${currentAge}岁` : '当前年龄：待补充'}
预期退休年龄：${retirementAge}岁

请输出：
1. 养老规划的核心逻辑（养老金三支柱）
2. 养老金缺口测算方法
3. 养老储备的积累策略（不同年龄段的侧重点）
4. 养老金融工具介绍（社保、企业年金、商业养老险、个人投资）
5. 退休后的收入规划思路
6. 行动建议：不同年龄段的养老规划优先级

保持专业、客观，不推荐具体产品。`

  try {
    const analysis = await callLLM(lmClient, CFP_SYSTEM_PROMPT, userPrompt)
    return {
      success: true,
      type: PLANNING_TYPES.RETIREMENT_PLAN,
      data: { analysis, riskLevel: assessRiskLevel(analysis) }
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

// ---- 统一调度入口 ----

async function execute(task) {
  const { type, params = {} } = task || {}

  const handlers = {
    [PLANNING_TYPES.FULL_FINANCIAL_PLAN]: () => generateFullPlan(params),
    [PLANNING_TYPES.CASH_FLOW_PLAN]: () => planCashFlow(params),
    [PLANNING_TYPES.EMERGENCY_FUND]: () => planCashFlow(params),
    [PLANNING_TYPES.DEBT_MANAGEMENT]: () => generateFullPlan(params),
    [PLANNING_TYPES.INSURANCE_PLAN]: () => planInsurance(params),
    [PLANNING_TYPES.INVESTMENT_ALLOCATION]: () => planInvestment(params),
    [PLANNING_TYPES.RETIREMENT_PLAN]: () => planRetirement(params),
    [PLANNING_TYPES.EDUCATION_FUND]: () => generateFullPlan(params)
  }

  const handler = handlers[type]
  if (!handler) {
    return { success: false, error: `未知规划类型: ${type}`, agent: 'cfp' }
  }

  try {
    const result = await handler()
    return { ...result, agent: 'cfp', taskType: type }
  } catch (error) {
    return { success: false, error: error.message, agent: 'cfp', taskType: type }
  }
}

export {
  PLANNING_TYPES,
  generateFullPlan,
  planCashFlow,
  planInsurance,
  planInvestment,
  planRetirement,
  execute
}

export default { execute, PLANNING_TYPES }
