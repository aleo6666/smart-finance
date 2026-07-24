import { randomUUID } from 'crypto'
import db from '../db.js'
import { queryFinanceSummary } from './financeQuery.js'

// ---- 复合意图检测 ----

const COMPOUND_PATTERNS = [
  // 分析 + 建议 / 推荐 / 规划
  { pattern: /分析.*并.*(?:建议|推荐|规划|调整|优化|改善)/, intent: 'analyze_and_advise' },
  { pattern: /(?:建议|推荐|规划|调整|优化).*并.*分析/, intent: 'analyze_and_advise' },
  { pattern: /分析.*消费.*(?:建议|规划|方案)/, intent: 'analyze_and_advise' },
  { pattern: /(?:帮我|给我|请).*(?:全面|综合|整体).*分析/, intent: 'analyze_and_advise' },

  // 对比
  { pattern: /(?:对比|比较).*(?:和|与|跟).*(?:月|季|年|期)/, intent: 'compare_periods' },
  { pattern: /(?:本月|这月).*(?:上月|上个月)/, intent: 'compare_periods' },
  { pattern: /(?:上月|上个月).*(?:本月|这月)/, intent: 'compare_periods' },
  { pattern: /(?:同比|环比|前后.*对比)/, intent: 'compare_periods' },

  // 预算 + 建议
  { pattern: /(?:检查|查看|核查).*预算.*(?:建议|调整|优化|改进)/, intent: 'budget_check_and_advise' },
  { pattern: /预算.*(?:超|不够|不够用).*(?:怎么办|建议|调整)/, intent: 'budget_check_and_advise' },
  { pattern: /(?:省钱|节流|控支).*(?:建议|方案|方法)/, intent: 'budget_check_and_advise' },

  // 回顾 + 规划
  { pattern: /(?:回顾|总结|复盘).*并.*(?:规划|计划|制定)/, intent: 'review_and_plan' },
  { pattern: /(?:最近|近期|这.*月).*(?:回顾|总结|复盘).*/, intent: 'review_and_plan' },
  { pattern: /(?:下一步|接下来|以后).*(?:怎么|如何).*(?:规划|安排|计划)/, intent: 'review_and_plan' },

  // 多问句（同时问多个问题）
  { pattern: /(?:多少|统计|汇总|合计|总共).*\?.*(?:多少|统计|建议|规划)/, intent: 'analyze_and_advise' },
  { pattern: /(?:还有|另外|同时).*(?:还有|另外|也).*(?:呢|吗)/, intent: 'analyze_and_advise' }
]

export function detectCompoundIntent(message) {
  const text = String(message || '')
  for (const { pattern, intent } of COMPOUND_PATTERNS) {
    if (pattern.test(text)) return intent
  }
  return null
}

// ---- 计划生成 ----

function buildPlan({ intent, userId, message, hints = {} }) {
  const planId = `plan_${randomUUID().slice(0, 12)}`
  const now = new Date()
  const thisMonth = now.toISOString().slice(0, 7)
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonth = prevDate.toISOString().slice(0, 7)

  const plans = {
    analyze_and_advise: () => ({
      planId, intent, message,
      steps: [
        { step_order: 1, intent: 'query_spending', input: { hints: { ...hints, queryKind: 'summary' } }, depends_on: [], label: '查询消费汇总' },
        { step_order: 2, intent: 'check_budget',   input: { hints },                                        depends_on: [], label: '检查预算执行' },
        { step_order: 3, intent: 'generate_advice', input: { message },                                      depends_on: [1, 2], label: '生成理财建议' },
        { step_order: 4, intent: 'aggregate',       input: { message },                                      depends_on: [3], label: '汇总分析报告' }
      ]
    }),

    compare_periods: () => ({
      planId, intent, message,
      steps: [
        { step_order: 1, intent: 'query_spending', input: { hints: { ...hints, month: thisMonth, queryKind: 'summary' } }, depends_on: [],  label: `查询${thisMonth}消费` },
        { step_order: 2, intent: 'query_spending', input: { hints: { ...hints, month: lastMonth, queryKind: 'summary' } }, depends_on: [],  label: `查询${lastMonth}消费` },
        { step_order: 3, intent: 'aggregate',       input: { message, label: '对比两个月的消费差异' },                                depends_on: [1, 2], label: '汇总对比结果' }
      ]
    }),

    budget_check_and_advise: () => ({
      planId, intent, message,
      steps: [
        { step_order: 1, intent: 'check_budget',   input: { hints },        depends_on: [],  label: '检查预算执行' },
        { step_order: 2, intent: 'generate_advice', input: { message },      depends_on: [1], label: '生成预算建议' },
        { step_order: 3, intent: 'aggregate',       input: { message },      depends_on: [2], label: '汇总分析报告' }
      ]
    }),

    review_and_plan: () => ({
      planId, intent, message,
      steps: [
        { step_order: 1, intent: 'query_spending', input: { hints: { ...hints, queryKind: 'summary' } },               depends_on: [],  label: '查询近期消费' },
        { step_order: 2, intent: 'query_spending', input: { hints: { ...hints, month: lastMonth, queryKind: 'summary' } }, depends_on: [],  label: '查询上月消费' },
        { step_order: 3, intent: 'generate_advice', input: { message },                                                 depends_on: [1, 2], label: '生成规划建议' },
        { step_order: 4, intent: 'aggregate',       input: { message },                                                 depends_on: [3], label: '汇总回顾报告' }
      ]
    })
  }

  const factory = plans[intent]
  if (!factory) return null
  return factory()
}

// ---- 步骤执行器 ----

async function runCheckBudget({ userId, hints = {}, dbClient = db }) {
  const month = hints.month || new Date().toISOString().slice(0, 7)
  const budgets = await dbClient('budgets')
    .where('user_id', userId)
    .where(builder => {
      builder.where('period', 'monthly').orWhere('period', 'once').orWhereNull('period')
    })

  const results = []
  for (const budget of budgets) {
    let query = dbClient('records')
      .where('user_id', userId)
      .where('type', 'expense')
      .whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [month])
    if (budget.category) query = query.where('category', budget.category)
    const row = await query.sum({ total: 'amount_cny' }).first()
    const spent = Number(row?.total || 0)
    const pct = budget.amount > 0 ? Math.round((spent / Number(budget.amount)) * 100) : 0
    results.push({
      category: budget.category || 'total',
      budget: Number(budget.amount),
      spent, remaining: Number(budget.amount) - spent,
      percent: pct,
      status: pct >= 100 ? 'over' : pct >= 80 ? 'warning' : 'ok'
    })
  }
  return { month, budgets: results, budgetCount: results.length }
}

export function createStepHandlers({ dbClient = db } = {}) {
  return {
    query_spending: async ({ userId, hints = {} }) => {
      return queryFinanceSummary({ userId, hints, db: dbClient })
    },

    check_budget: async ({ userId, hints = {} }) => {
      return runCheckBudget({ userId, hints, dbClient })
    },

    generate_advice: async ({ previousOutputs = [], message = '' }) => {
      const spending = previousOutputs.find(o => o?.stepIntent === 'query_spending')?.data
      const budget   = previousOutputs.find(o => o?.stepIntent === 'check_budget')?.data
      const tips = []

      if (spending) {
        if (spending.total > 0) tips.push(`本月已记录${spending.count || 0}笔消费，合计${spending.total.toFixed(2)}元`)
        if (spending.average > 0) tips.push(`平均每笔${spending.average.toFixed(2)}元`)
        if (spending.maxRecord) tips.push(`最大单笔支出${Number(spending.maxRecord.amount).toFixed(2)}元（${spending.maxRecord.date}）`)
      }
      if (budget && Array.isArray(budget.budgets)) {
        const over = budget.budgets.filter(b => b.status === 'over')
        const warn = budget.budgets.filter(b => b.status === 'warning')
        if (over.length) tips.push(`⚠️ ${over.map(b => `${b.category === 'total' ? '总预算' : b.category}已超支`).join('、')}`)
        if (warn.length) tips.push(`⚡ ${warn.map(b => `${b.category === 'total' ? '总预算' : b.category}接近上限`).join('、')}`)
        if (!over.length && !warn.length && budget.budgets.length) tips.push('✅ 当前预算均在可控范围内')
      }
      if (!tips.length) tips.push('请先记录消费数据，以便生成个性化建议。')
      else tips.push('建议持续关注消费趋势，按需调整预算配置。')

      return { advice: tips.join('。\n'), tipCount: tips.length }
    },

    aggregate: async ({ previousOutputs = [], message = '' }) => {
      const parts = []
      let totalSpending = 0, recordCount = 0
      for (const output of previousOutputs) {
        if (!output) continue
        if (output.stepIntent === 'query_spending' && output.data) {
          const d = output.data
          const ml = d.hints?.month ? `(${d.hints.month})` : ''
          if (d.count > 0) {
            parts.push(`📊 消费统计${ml}：${d.count}笔，合计${(d.total || 0).toFixed(2)}元`)
            totalSpending += (d.total || 0)
            recordCount += (d.count || 0)
          }
        }
        if (output.stepIntent === 'check_budget' && output.data?.budgets?.length) {
          const list = output.data.budgets
            .map(b => `${b.category === 'total' ? '总预算' : b.category}：已花${b.spent.toFixed(2)}/预算${b.budget.toFixed(2)}（${b.percent}% ${b.status === 'over' ? '超支' : b.status === 'warning' ? '预警' : '正常'}）`)
            .join('\n')
          parts.push(`💰 预算执行（${output.data.month}）：\n${list}`)
        }
        if (output.stepIntent === 'generate_advice' && output.data) {
          parts.push(`💡 建议：\n${output.data.advice}`)
        }
      }
      return {
        report: parts.join('\n\n'),
        summary: `共分析${recordCount}条记录，涉及金额${totalSpending.toFixed(2)}元`,
        totalSpending, recordCount, stepCount: previousOutputs.length
      }
    }
  }
}

// ---- 并行计划执行 ----

export async function planMultiStepTask({ message, userId, hints = {} }) {
  const compoundIntent = detectCompoundIntent(message)
  if (!compoundIntent) return null
  return buildPlan({ intent: compoundIntent, userId, message, hints })
}

/**
 * 按轮次并行执行：同一轮（无未满足依赖的步骤）并发执行，
 * 下一轮等待所有上轮完成后再启动。
 */
export async function executePlan({
  plan, userId,
  dbClient = db,
  stepHandlers = createStepHandlers({ dbClient }),
  recordStepFn = null
}) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return { success: false, error: '无效的执行计划' }
  }

  const { planId, steps } = plan
  const stepMap = new Map()

  // 插入所有步骤记录
  for (const step of steps) {
    await dbClient('task_steps').insert({
      plan_id: planId, user_id: userId,
      step_order: step.step_order, intent: step.intent,
      input_json: JSON.stringify(step.input || {}),
      depends_on: step.depends_on?.length ? Math.max(...step.depends_on) : null,
      status: 'queued'
    })
    stepMap.set(step.step_order, step)
  }

  const resultsByOrder = {}     // { step_order: { stepIntent, stepOrder, data, success, ... } }
  const pending = new Set(steps.map(s => s.step_order))

  while (pending.size > 0) {
    // 找出所有依赖已满足的步骤 → 同一轮并发
    const ready = []
    for (const stepOrder of pending) {
      const step = stepMap.get(stepOrder)
      const deps = step.depends_on || []
      const allDepsSatisfied = deps.every(depOrder => {
        if (!pending.has(depOrder)) {
          // 依赖已执行完毕
          return resultsByOrder[depOrder]?.success === true
        }
        return false // 依赖还在 pending 中
      })
      if (allDepsSatisfied) ready.push(step)
    }

    if (ready.length === 0) {
      // 剩余步骤依赖不可能满足（类似死锁），标记跳过
      for (const stepOrder of pending) {
        await dbClient('task_steps')
          .where({ plan_id: planId, step_order: stepOrder })
          .update({ status: 'skipped', error_message: '依赖步骤未满足', started_at: dbClient.fn.now() })
        resultsByOrder[stepOrder] = { stepIntent: stepMap.get(stepOrder).intent, stepOrder, success: false, error: 'unresolved dependency' }
      }
      break
    }

    // 并发执行本轮所有就绪步骤
    const roundResults = await Promise.all(ready.map(async (step) => {
      const startedAt = Date.now()
      try {
        await dbClient('task_steps')
          .where({ plan_id: planId, step_order: step.step_order })
          .update({ status: 'running', started_at: dbClient.fn.now() })

        const handler = stepHandlers[step.intent]
        if (!handler) throw new Error(`未知步骤类型: ${step.intent}`)

        // 全部已完成的步骤输出作为上下文（不只是直接依赖）
        const previousOutputs = Object.values(resultsByOrder)
          .filter(r => r && r.success)

        const result = await handler({
          userId,
          hints: step.input?.hints || {},
          message: step.input?.message || '',
          previousOutputs,
          stepIntent: step.intent
        })

        const latencyMs = Date.now() - startedAt
        await dbClient('task_steps')
          .where({ plan_id: planId, step_order: step.step_order })
          .update({ status: 'succeeded', output_json: JSON.stringify(result || {}), latency_ms: latencyMs, completed_at: dbClient.fn.now() })

        if (recordStepFn) {
          recordStepFn({ userId, stepIntent: step.intent, latencyMs, success: true }).catch(() => {})
        }
        return { stepIntent: step.intent, stepOrder: step.step_order, success: true, data: result, latencyMs }
      } catch (error) {
        const latencyMs = Date.now() - startedAt
        await dbClient('task_steps')
          .where({ plan_id: planId, step_order: step.step_order })
          .update({ status: 'failed', error_message: error.message, latency_ms: latencyMs, completed_at: dbClient.fn.now() })

        if (recordStepFn) {
          recordStepFn({ userId, stepIntent: step.intent, latencyMs, success: false, errorMessage: error.message }).catch(() => {})
        }
        return { stepIntent: step.intent, stepOrder: step.step_order, success: false, error: error.message, latencyMs }
      }
    }))

    for (const r of roundResults) {
      resultsByOrder[r.stepOrder] = r
      pending.delete(r.stepOrder)
    }
  }

  // 提取最终报告
  const stepResults = steps.map(s => resultsByOrder[s.step_order]).filter(Boolean)
  const aggregateStep = stepResults.find(r => r.stepIntent === 'aggregate' && r.success)
  const adviceStep   = stepResults.find(r => r.stepIntent === 'generate_advice' && r.success)

  const report  = aggregateStep?.data?.report  || ''
  const summary = aggregateStep?.data?.summary || ''
  const advice  = adviceStep?.data?.advice     || ''

  return {
    success: true, planId,
    steps: stepResults,
    report, summary, advice,
    stepCount: stepResults.length,
    succeededCount: stepResults.filter(r => r.success).length,
    failedCount:    stepResults.filter(r => !r.success).length
  }
}

export default { planMultiStepTask, executePlan, detectCompoundIntent, createStepHandlers }
