import defaultLmStudioClient from './lmStudioClient.js'

// ---- 关键字回退词库（保留原有逻辑，作为 LLM 不可用时的降级） ----

const CATEGORY_KEYWORDS = [
  ['餐饮', ['饭', '午饭', '晚饭', '早餐', '外卖', '奶茶', '咖啡', '食堂', '餐', '吃']],
  ['交通', ['打车', '地铁', '公交', '高铁', '火车', '机票', '加油', '停车']],
  ['购物', ['买', '购物', '淘宝', '京东', '衣服', '鞋', '超市']],
  ['娱乐', ['电影', '游戏', 'KTV', '旅游', '门票', '会员']],
  ['住房', ['房租', '水电', '物业', '燃气', '宽带']],
  ['医疗', ['医院', '药', '体检', '门诊']],
  ['教育', ['课程', '学费', '书', '考试', '培训']],
  ['通讯', ['话费', '流量', '手机费']],
  ['礼物', ['礼物', '红包', '请客', '生日']]
]

const INCOME_WORDS = ['收入', '工资', '奖金', '报销', '退款', '兼职', '利息', '收到了', '收到', '红包', '转账', '津贴', '补贴', '提现', '分红', '退款到账', '兼职费', '外快', '副业']
const QUERY_WORDS = ['多少', '统计', '分析', '报告', '汇总', '趋势', '占比']
const ADVICE_WORDS = ['建议', '省钱', '规划', '理财', '怎么', '如何']
const GOAL_WORDS = ['目标', '存钱', '储蓄', '想买']

function inferCategory(text) {
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(keyword => text.includes(keyword))) return category
  }
  return '其他'
}

function extractAmount(text) {
  const match = String(text).match(/(\d+(?:\.\d{1,2})?)\s*(元|块|人民币)?/)
  return match ? Number(match[1]) : null
}

function extractDate(text) {
  const today = new Date()
  if (text.includes('昨天')) { const d = new Date(today); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10) }
  if (text.includes('前天')) { const d = new Date(today); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10) }
  return today.toISOString().slice(0, 10)
}

function cleanDescription(text) {
  return String(text)
    .replace(/\d+(?:\.\d{1,2})?\s*(元|块|人民币)?/g, '')
    .replace(/今天|昨天|前天|花了|消费|支出|用了|收入|收到|收到了/g, '')
    .trim()
}

function isIncome(text) {
  return INCOME_WORDS.some(word => text.includes(word))
}

// ---- 多笔拆分（纯规则，LLM 不参与拆单） ----

const MULTI_SEPARATOR_RE = /(还有|然后|以及|和|跟|与|再|、|，|。)/g

// 用分隔词拆分"物品+金额"子句；分隔词前后都出现数字才算真正分隔，
// 避免"和牛套餐88"这类"和"作为词首被误拆。
function splitMultiClauses(text) {
  const matches = []
  const re = new RegExp(MULTI_SEPARATOR_RE.source, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    matches.push({ index: m.index, length: m[0].length })
  }
  if (!matches.length) return [text]

  const clauses = []
  let start = 0
  for (const { index, length } of matches) {
    const before = text.slice(start, index)
    const after = text.slice(index + length)
    if (/\d/.test(before) && /\d/.test(after)) {
      clauses.push(before)
      start = index + length
    }
  }
  clauses.push(text.slice(start))
  return clauses
}

// 按单笔规则解析子句；金额和物品都有的才算一笔。
function parseSingleRecord(text, date) {
  const amount = extractAmount(text)
  if (amount == null) return null
  const description = cleanDescription(text)
  if (!description) return null
  const type = isIncome(text) ? 'income' : 'expense'
  const category = type === 'income' ? '收入' : inferCategory(text)
  return { type, amount, category, description, date: date || extractDate(text) }
}

// 拆分出 ≥2 个有效子句时返回多笔结果；否则返回 null，交给单笔逻辑。
function buildMultiRecordResult(text) {
  const clauses = splitMultiClauses(text)
  if (clauses.length < 2) return null
  const date = extractDate(text)
  const records = clauses.map(clause => parseSingleRecord(clause, date)).filter(Boolean)
  if (records.length < 2) return null
  const message = `已记录 ${records.length} 笔：${records.map(record => `${record.description} ¥${record.amount.toFixed(2)}`).join('、')}`
  return { intent: 'record', message, data: { records } }
}

async function classifyIncomeViaLLM(text, amount, lmStudioClient) {
  try {
    const reply = await Promise.race([
      lmStudioClient.chat([
        { role: 'user', content: `判断以下记账文本是收入还是支出，只回复income或expense。\n文本开始>>>${String(text).slice(0, 200)}<<<文本结束` }
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('classifyIncomeViaLLM timeout after 5000ms')), 5000)
      )
    ])
    const trimmed = String(reply).trim().toLowerCase()
    return trimmed === 'income' ? 'income' : trimmed === 'expense' ? 'expense' : null
  } catch {
    return null
  }
}

async function localParse(message, { lmStudioClient } = {}) {
  const text = String(message || '')

  // 多笔拆分：纯规则，不依赖 LLM
  const multi = buildMultiRecordResult(text)
  if (multi) return multi

  const amount = extractAmount(text)

  if (amount) {
    let type = isIncome(text) ? 'income' : 'expense'
    let category = type === 'income' ? '收入' : inferCategory(text)
    const description = cleanDescription(text) || category

    // 大额支出通过 LLM 二次确认收入类型
    if (type === 'expense' && amount >= 500 && lmStudioClient) {
      const llmType = await classifyIncomeViaLLM(text, amount, lmStudioClient)
      if (llmType === 'income') {
        type = 'income'
        category = '收入'
      } else if (llmType === null) {
        return { intent: 'record', message: `已记录：支出 ${description} ¥${amount.toFixed(2)}`, data: { type: 'expense', amount, category, description, date: extractDate(text), uncertainType: true } }
      }
    }

    return {
      intent: 'record',
      message: `已记录：${type === 'income' ? '收入' : '支出'} ${description} ¥${amount.toFixed(2)}`,
      data: { type, amount, category, description, date: extractDate(text) }
    }
  }

  if (GOAL_WORDS.some(word => text.includes(word))) {
    return { intent: 'goal', message: '可以，我会帮你记录这个目标。', data: { name: cleanDescription(text) || '储蓄目标', target_amount: 1000, deadline: null } }
  }

  if (QUERY_WORDS.some(word => text.includes(word))) {
    return { intent: 'query', message: '我可以帮你查看消费统计。', data: null }
  }

  if (ADVICE_WORDS.some(word => text.includes(word))) {
    return { intent: 'advice', message: '建议先保持连续记账，再根据月度分类占比优化预算。', data: null }
  }

  return { intent: 'chat', message: '你可以告诉我一笔消费，比如"今天午饭花了25元"。', data: null }
}

// ---- LLM 意图识别 ----

const SYSTEM_PROMPT = `你是一个财务记账助手的意图识别模块。分析用户输入，输出严格 JSON（不要 markdown 代码块，不要额外文字）。

## 输出格式

{
  "intent": "record|query|advice|goal|chat",
  "message": "给用户的简短确认语",
  "data": {
    // 仅 record 意图需要以下字段
    "type": "income|expense",
    "amount": 数字,
    "category": "餐饮|交通|购物|娱乐|住房|医疗|教育|通讯|礼物|收入|其他",
    "description": "简短描述",
    "date": "YYYY-MM-DD",
    "merchant": "商家名或null",
    "currency": "CNY"
  }
}

## 意图判定规则

### record（记账）
用户表达了一笔收支。关键字如："花了"、"买了"、"付了"、"消费"、"收入"、"工资"、"进账"、"收到"。
- 有金额数字时优先判定为 record
- type 默认 expense，除非明确提到收入类词（工资/奖金/报销/退款/到账/收到）
- 没有金额时尝试从上下文推断："一顿饭"可推断为餐饮但 amount 传 null
- category 从类别列表选最匹配的
- date 优先取用户提到的日期，否则用今天

### query（查询/分析）
用户在问消费数据、想看统计。关键字如："多少"、"花了多少"、"统计"、"汇总"、"趋势"、"分析"、"查看"、"明细"、"账单"、"还剩"、"本月"、"上月"。
- 不带金额数字的疑问句优先判 query

### advice（理财建议）
用户想获得建议或规划。关键字如："建议"、"怎么省钱"、"如何理财"、"规划"、"预算建议"、"省钱方案"。

### goal（目标设定）
用户想设定储蓄或预算目标。关键字如："存钱目标"、"想攒"、"储蓄计划"、"想买"。

### chat（闲聊）
问候、感谢、模糊表达或无法匹配以上四种的输入。

## 注意事项
- 有明确金额数字 + 消费/收入动词 → 一定是 record，不要判成 advice 或 query
- "用了X元/块"、"付了X元"、"花了X元"、"买了"、"充了" → 都是 record
- 同时有金额数字和"怎么/如何/建议"类词时，优先 record（用户先记了一笔再问后续）
- 月份/时间范围提到但无金额 → query
- 不要编造金额，不确定时传 null
- 金额只取数字，不要带单位
- "用了"=花了，"付了"=花了，"充了"=花了。这些都是消费动词。`

// ---- 解析 LLM 返回 ----

function extractJson(text) {
  if (!text) return null
  // 去掉可能的 markdown 代码块包裹
  let cleaned = String(text).trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  // 找到第一个 { 到最后一个 }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

const VALID_INTENTS = new Set(['record', 'query', 'advice', 'goal', 'chat'])
const VALID_CATEGORIES = new Set(['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '收入', '其他'])

function normalizeAgentResult(parsed, message) {
  const intent = VALID_INTENTS.has(parsed?.intent) ? parsed.intent : 'chat'
  const result = {
    intent,
    message: parsed?.message || '',
    data: null
  }

  // record 意图的结构化数据
  if (intent === 'record') {
    const data = parsed?.data || {}
    const amount = typeof data.amount === 'number' && data.amount > 0 ? data.amount : null
    const type = data.type === 'income' ? 'income' : 'expense'
    const category = VALID_CATEGORIES.has(data.category) ? data.category : (type === 'income' ? '收入' : '其他')
    const description = String(data.description || cleanDescription(message) || category).slice(0, 200)
    const date = data.date && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : extractDate(message)
    const merchant = data.merchant ? String(data.merchant).slice(0, 128) : null

    result.data = { type, amount, category, description, date, currency: 'CNY', merchant }
    result.message = result.message || `已记录：${type === 'income' ? '收入' : '支出'} ${description}${amount ? ` ¥${amount.toFixed(2)}` : ''}`
  }

  // goal 意图
  if (intent === 'goal') {
    const data = parsed?.data || {}
    result.data = {
      name: data.name || cleanDescription(message) || '储蓄目标',
      target_amount: typeof data.amount === 'number' ? data.amount : (typeof data.target_amount === 'number' ? data.target_amount : 1000),
      deadline: data.deadline || null
    }
    result.message = result.message || `可以，我会帮你记录这个目标。`
  }

  return result
}

// ---- 主入口 ----

/**
 * 带超时的 LLM 调用：NLU 要求低延迟，超时即回退关键字解析。
 */
async function chatWithDeadline(lmStudioClient, messages, timeoutMs = 15000) {
  return Promise.race([
    lmStudioClient.chat(messages),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`NLU agent timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ])
}

export async function processMessage(_identity, userMessage, {
  lmStudioClient = defaultLmStudioClient
} = {}) {
  const message = String(userMessage || '')
  if (!message.trim()) {
    return { intent: 'chat', message: '你可以告诉我一笔消费，比如"今天午饭花了25元"。', data: null }
  }

  // 多笔拆分：规则解析优先，先于 LLM（确定性拆单）
  const multi = buildMultiRecordResult(message)
  if (multi) return multi

  // 1. 尝试 LLM 意图识别（15 秒超时，避免阻塞用户）
  try {
    const reply = await chatWithDeadline(lmStudioClient, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message }
    ])
    const parsed = extractJson(reply)
    if (parsed && parsed.intent) {
      return normalizeAgentResult(parsed, message)
    }
    console.warn('[NLU] LLM 返回格式无效，回退关键字解析')
  } catch (error) {
    console.warn('[NLU] LLM 调用失败，回退关键字解析:', error.message)
  }

  // 2. 降级：关键字匹配（大额支出可能触发 LLM 二次确认）
  return await localParse(message, { lmStudioClient })
}

// 导出降级函数供测试使用
export { localParse, inferCategory, extractAmount, extractDate, cleanDescription, isIncome, classifyIncomeViaLLM }
