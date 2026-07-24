/**
 * 检索 Agent - 专职执行 RAG 检索、数据查询与规则匹配
 *
 * 职责：
 * 1. 向量检索（RAG）- 从 Qdrant 检索相关账目记录
 * 2. 结构化数据查询 - 从数据库查询财务数据
 * 3. 知识库/规则检索 - 查询财务规则、预算配置等
 *
 * 不做：计算、推理、生成建议（交给计算 Agent 和主控）
 */

import db from '../db.js'
import { queryFinanceSummary } from './financeQuery.js'
import { retrieveSimilar } from './vectorMemory.js'
import config from '../config.js'

// ---- 工具类型定义 ----

const RETRIEVAL_TYPES = {
  FINANCE_SUMMARY: 'finance_summary',   // 财务汇总查询
  RECORDS_VECTOR: 'records_vector',     // 向量语义检索
  BUDGET_CONFIG: 'budget_config',       // 预算配置查询
  CATEGORY_STATS: 'category_stats'      // 分类统计
}

// ---- 1. 财务汇总查询 ----

async function retrieveFinanceSummary({ userId, hints = {} }) {
  if (!userId) {
    return { success: false, error: '缺少 userId', data: null }
  }
  try {
    const result = await queryFinanceSummary({ userId, hints, db })
    return {
      success: true,
      type: RETRIEVAL_TYPES.FINANCE_SUMMARY,
      data: {
        count: result.count,
        total: result.total,
        average: result.average,
        maxRecord: result.maxRecord,
        records: result.records,
        hints: result.hints
      }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 2. 向量语义检索（RAG 用）----

async function retrieveVectorRecords({ userId, query, limit = null, hints = {} }) {
  if (!userId || !query) {
    return { success: false, error: '缺少 userId 或 query', data: null }
  }
  try {
    const topK = limit || config.rag?.topK || 5
    const records = await retrieveSimilar(query, { userId, limit: topK, ...hints })
    return {
      success: true,
      type: RETRIEVAL_TYPES.RECORDS_VECTOR,
      data: {
        records,
        count: records.length,
        query
      }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 3. 预算配置查询 ----

async function retrieveBudgetConfig({ userId, month = null }) {
  if (!userId) {
    return { success: false, error: '缺少 userId', data: null }
  }
  try {
    const budgets = await db('budgets')
      .where('user_id', userId)
      .where(builder => {
        builder.where('period', 'monthly').orWhere('period', 'once').orWhereNull('period')
      })
      .select()

    return {
      success: true,
      type: RETRIEVAL_TYPES.BUDGET_CONFIG,
      data: {
        budgets: budgets.map(b => ({
          id: b.id,
          category: b.category || 'total',
          amount: Number(b.amount),
          period: b.period || 'monthly'
        })),
        count: budgets.length,
        month
      }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 4. 分类统计查询 ----

async function retrieveCategoryStats({ userId, month = null }) {
  if (!userId) {
    return { success: false, error: '缺少 userId', data: null }
  }
  try {
    let query = db('records')
      .where('user_id', userId)
      .where('type', 'expense')

    if (month) {
      query = query.whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [month])
    }

    const rows = await query
      .select('category')
      .select(db.raw('SUM(COALESCE(amount_cny, amount)) as total'))
      .select(db.raw('COUNT(*) as count'))
      .groupBy('category')
      .orderBy('total', 'desc')

    const stats = rows.map(row => ({
      category: row.category || '其他',
      total: Number(row.total || 0),
      count: Number(row.count || 0)
    }))

    const grandTotal = stats.reduce((sum, s) => sum + s.total, 0)
    stats.forEach(s => {
      s.percentage = grandTotal > 0 ? Math.round((s.total / grandTotal) * 100) : 0
    })

    return {
      success: true,
      type: RETRIEVAL_TYPES.CATEGORY_STATS,
      data: { stats, grandTotal, month }
    }
  } catch (error) {
    return { success: false, error: error.message, data: null }
  }
}

// ---- 统一调度入口 ----

/**
 * 执行检索任务
 * @param {Object} task - 检索任务描述
 * @param {string} task.type - 检索类型
 * @param {string} task.userId - 用户 ID
 * @param {Object} task.params - 检索参数
 * @returns {Promise<Object>} 检索结果
 */
async function execute(task) {
  const { type, userId, params = {} } = task || {}

  if (!userId) {
    return { success: false, error: '检索任务缺少 userId', agent: 'retrieval' }
  }

  const handlers = {
    [RETRIEVAL_TYPES.FINANCE_SUMMARY]: () => retrieveFinanceSummary({ userId, hints: params.hints || {} }),
    [RETRIEVAL_TYPES.RECORDS_VECTOR]: () => retrieveVectorRecords({ userId, query: params.query, hints: params.hints || {}, limit: params.limit }),
    [RETRIEVAL_TYPES.BUDGET_CONFIG]: () => retrieveBudgetConfig({ userId, month: params.month }),
    [RETRIEVAL_TYPES.CATEGORY_STATS]: () => retrieveCategoryStats({ userId, month: params.month })
  }

  const handler = handlers[type]
  if (!handler) {
    return { success: false, error: `未知检索类型: ${type}`, agent: 'retrieval' }
  }

  try {
    const result = await handler()
    return { ...result, agent: 'retrieval', taskType: type }
  } catch (error) {
    return { success: false, error: error.message, agent: 'retrieval', taskType: type }
  }
}

export {
  RETRIEVAL_TYPES,
  retrieveFinanceSummary,
  retrieveVectorRecords,
  retrieveBudgetConfig,
  retrieveCategoryStats,
  execute
}

export default { execute, RETRIEVAL_TYPES }
