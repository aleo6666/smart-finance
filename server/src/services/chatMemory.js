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
const INCOME_WORDS = ['收入', '工资', '奖金', '收款', '收到']
const EXPENSE_WORDS = ['支出', '花了', '消费', '用了']
const RECENT_WORDS = ['最近', '近几笔', '最近几笔', '明细']
const LARGEST_WORDS = ['最大', '最高', '最贵', '最大一笔']
const SUMMARY_WORDS = ['多少', '合计', '统计', '总共', '一共']

function hasAny(text, words) {
  return words.some(word => text.includes(word))
}

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

  if (hasAny(text, INCOME_WORDS)) hints.type = 'income'
  if (hasAny(text, EXPENSE_WORDS)) hints.type = 'expense'

  if (hasAny(text, RECENT_WORDS)) hints.queryKind = 'recent'
  else if (hasAny(text, LARGEST_WORDS)) hints.queryKind = 'largest'
  else if (hasAny(text, SUMMARY_WORDS)) hints.queryKind = 'summary'

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
