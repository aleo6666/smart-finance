import db from '../db.js'

// ---- 风险分级 ----

const HIGH_RISK_WORDS = [
  'all in', '全仓', '梭哈', '贷款投资', '借钱投资', '杠杆',
  '保证收益', '稳赚', '包赚', '无风险', '零风险',
  '内幕', '内部消息', '必涨', '一定会涨',
  '具体股票', '具体基金', '具体币种',
  '抵押', '信用卡套现'
]

const MEDIUM_RISK_WORDS = [
  '建议买入', '建议卖出', '推荐购买', '推荐卖出',
  '减仓', '加仓', '重仓', '满仓',
  '某只股票', '某只基金', '具体金额',
  '预算削减', '降低预算到', '预算调整为',
  '储蓄目标', '存钱目标'
]

const DISCLAIMER_TEMPLATES = {
  high: '⚠️ 重要提示：理财建议涉及重大财务决策，存在较高风险。AI 生成内容仅供参考，不构成专业投资建议。建议咨询持牌理财顾问后再做决定。平台不对基于此建议的任何财务损失承担责任。',
  medium: '⚡ 提示：此建议包含具体财务调整方向，请结合自身实际情况判断。AI 分析基于历史记账数据，可能未涵盖所有个人财务因素。如有疑问，建议咨询专业人士。',
  low: '📌 提示：此为通用理财建议，基于您的记账数据自动生成。具体执行请根据个人实际情况调整。'
}

export function assessRiskLevel(adviceText = '') {
  const text = String(adviceText).toLowerCase()
  if (HIGH_RISK_WORDS.some(word => text.includes(word.toLowerCase()))) return 'high'
  if (MEDIUM_RISK_WORDS.some(word => text.includes(word.toLowerCase()))) return 'medium'
  return 'low'
}

// ---- 提交审核 ----

export async function submitAdviceForReview({
  userId,
  adviceText,
  context = {},
  dbClient = db
}) {
  const riskLevel = assessRiskLevel(adviceText)
  const disclaimer = DISCLAIMER_TEMPLATES[riskLevel]

  const [id] = await dbClient('advice_reviews').insert({
    user_id: userId,
    advice_text: adviceText,
    risk_level: riskLevel,
    status: riskLevel === 'low' ? 'approved' : 'pending',
    disclaimer,
    context_json: JSON.stringify(context),
    original_advice: null
  })

  const needsReview = riskLevel !== 'low'

  return {
    id,
    riskLevel,
    needsReview,
    disclaimer,
    adviceText: needsReview ? null : adviceText,
    message: needsReview
      ? '该建议内容已提交审核，审核通过后将通知您。'
      : adviceText
  }
}

// ---- 审核操作 ----

async function getReviewOrThrow(id, dbClient) {
  const review = await dbClient('advice_reviews').where({ id }).first()
  if (!review) throw Object.assign(new Error('审核记录不存在'), { statusCode: 404 })
  return review
}

export async function approveReview(id, { reviewedBy = null, dbClient = db } = {}) {
  const review = await getReviewOrThrow(id, dbClient)
  if (review.status !== 'pending') {
    throw Object.assign(new Error(`无法批准状态为"${review.status}"的记录`), { statusCode: 409 })
  }

  await dbClient('advice_reviews').where({ id }).update({
    status: 'approved',
    reviewed_by: reviewedBy,
    reviewed_at: dbClient.fn.now()
  })

  return { id, status: 'approved', adviceText: review.advice_text, disclaimer: review.disclaimer }
}

export async function rejectReview(id, { reviewedBy = null, reason = '', dbClient = db } = {}) {
  const review = await getReviewOrThrow(id, dbClient)
  if (review.status !== 'pending') {
    throw Object.assign(new Error(`无法拒绝状态为"${review.status}"的记录`), { statusCode: 409 })
  }

  await dbClient('advice_reviews').where({ id }).update({
    status: 'rejected',
    reviewed_by: reviewedBy,
    reviewed_at: dbClient.fn.now(),
    disclaimer: reason ? `${review.disclaimer || ''}\n拒绝原因：${reason}` : review.disclaimer
  })

  return { id, status: 'rejected', reason }
}

export async function modifyReview(id, { reviewedBy = null, modifiedAdvice = '', reason = '', dbClient = db } = {}) {
  const review = await getReviewOrThrow(id, dbClient)
  if (review.status !== 'pending') {
    throw Object.assign(new Error(`无法修改状态为"${review.status}"的记录`), { statusCode: 409 })
  }

  if (!modifiedAdvice) {
    throw Object.assign(new Error('修改时必须提供 modifiedAdvice'), { statusCode: 400 })
  }

  const reRisk = assessRiskLevel(modifiedAdvice)

  await dbClient('advice_reviews').where({ id }).update({
    status: 'modified',
    original_advice: review.advice_text,
    advice_text: modifiedAdvice,
    risk_level: reRisk,
    reviewed_by: reviewedBy,
    reviewed_at: dbClient.fn.now(),
    disclaimer: reason
      ? `${DISCLAIMER_TEMPLATES[reRisk]}\n修改说明：${reason}`
      : DISCLAIMER_TEMPLATES[reRisk]
  })

  return { id, status: 'modified', adviceText: modifiedAdvice, riskLevel: reRisk }
}

// ---- 查询 ----

export async function listPendingReviews({
  status = 'pending',
  offset = 0,
  limit = 50,
  dbClient = db
} = {}) {
  const query = dbClient('advice_reviews')
    .select(
      'id', 'user_id', 'advice_text', 'risk_level', 'status',
      'reviewed_by', 'reviewed_at', 'disclaimer', 'context_json',
      'created_at', 'updated_at'
    )
    .orderBy('risk_level', 'asc')
    .orderBy('created_at', 'desc')
    .offset(offset)
    .limit(Math.min(limit, 200))

  if (status) query.where('status', status)

  const rows = await query

  const [{ total }] = await dbClient('advice_reviews')
    .where('status', status || 'pending')
    .count({ total: '*' })

  return {
    reviews: rows.map(parseReviewRow),
    total: Number(total),
    offset,
    limit
  }
}

export async function getReviewById(id, { dbClient = db } = {}) {
  const review = await getReviewOrThrow(id, dbClient)
  return parseReviewRow(review)
}

function parseReviewRow(row) {
  if (!row) return null
  let context = {}
  try {
    context = typeof row.context_json === 'string'
      ? JSON.parse(row.context_json)
      : (row.context_json || {})
  } catch { /* keep empty */ }

  // 不在列表接口暴露原始未审核建议文本
  const isPending = row.status === 'pending'
  return {
    id: row.id,
    userId: row.user_id,
    adviceText: isPending ? '[待审核]' : row.advice_text,
    riskLevel: row.risk_level,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    disclaimer: row.disclaimer,
    context,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export default {
  assessRiskLevel,
  submitAdviceForReview,
  approveReview,
  rejectReview,
  modifyReview,
  listPendingReviews,
  getReviewById
}
