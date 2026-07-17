function formatMonth(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function previousMonth(date) {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1)
  return formatMonth(d)
}

const CATEGORY_WORDS = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物']

function findCategory(text) {
  return CATEGORY_WORDS.find(item => text.includes(item))
}

export function extractQueryHints(message, { now = new Date(), context = [] } = {}) {
  const text = String(message || '')
  const hints = {}

  if (text.includes('本月')) hints.month = formatMonth(now)
  if (text.includes('上月')) hints.month = previousMonth(now)

  const category = findCategory(text) || findCategory(context.map(item => item.content).join(' '))
  if (category) hints.category = category

  return hints
}

export function summarizeRecords(records = []) {
  const total = records.reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const categories = [...new Set(records.map(record => record.category).filter(Boolean))]
  return { count: records.length, total, categories }
}

export function buildMemoryReply({ intent, baseMessage, records = [] }) {
  if (!records.length) return baseMessage

  const summary = summarizeRecords(records)
  const categories = summary.categories.length ? summary.categories.join('、') : '未分类'

  if (intent === 'advice') {
    return `我找到 ${summary.count} 条相关记录，合计约 ${summary.total.toFixed(2)} 元，主要涉及 ${categories}。这类支出近期较集中，可以先设置分类预算，或观察本月占比后再调整。`
  }

  return `我找到 ${summary.count} 条相关记录，总金额约 ${summary.total.toFixed(2)} 元，主要集中在 ${categories}。`
}
