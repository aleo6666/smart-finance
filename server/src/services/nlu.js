import Anthropic from '@anthropic-ai/sdk'
import { getMemoryContext } from './memory.js'
import { getContextData } from './analyzer.js'

const HAS_API_KEY = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-api-key-here'

const anthropic = HAS_API_KEY ? new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
}) : null

const SYSTEM_PROMPT = `你是一个智能个人财务记账助手，名叫"小财"。你的职责是帮助用户通过自然语言记账、查询消费、提供理财建议。

## 核心能力
1. **记账**: 从用户自然语言中提取消费信息并记录
2. **查询**: 回答用户关于消费、预算、目标的问题
3. **建议**: 基于消费数据提供个性化理财建议
4. **闲聊**: 与用户自然互动

## 消费类别
支持以下类别: 餐饮、交通、购物、娱乐、住房、医疗、教育、通讯、礼物、其他

## 响应格式（必须严格遵守）
你必须返回一个严格的 JSON 对象，格式如下：
{
  "intent": "record|query|advice|chat|goal",
  "message": "自然语言回复",
  "data": {
    "type": "expense或income",
    "amount": 数字金额,
    "category": "类别",
    "description": "描述",
    "date": "YYYY-MM-DD日期"
  }
}

## 规则
- intent为"record"时，data中必须包含type, amount, category, date字段，description可选
- intent为"query"时，data可为null
- intent为"advice"时，data可为null
- intent为"chat"时，data可为null
- intent为"goal"时，表示用户想创建储蓄目标
- 金额默认为"元"（人民币）
- 日期默认为今天，如用户说"昨天"则用昨天日期
- 如果用户没有指定类别，根据描述智能推断：外卖/午餐/晚餐→餐饮，打车/地铁/公交→交通，衣服/鞋子/电子产品→购物，电影/游戏/KTV→娱乐，房租/水电→住房
- 如果用户说"收入"、"工资"、"奖金"等，type设为"income"
- 回复要温馨、鼓励，适当使用emoji
- 对于"花了XX元"这类表述，即使没有明确类别也要尽量推断
- 如果用户只是问好或闲聊，intent设为"chat"并友好回应`

// ============ 本地规则引擎（无需 API Key 的降级方案） ============

const CATEGORY_KEYWORDS = {
  '餐饮': ['餐', '饭', '外卖', '食堂', '早餐', '午餐', '晚饭', '晚餐', '吃', '面', '米', '粉', '菜', '奶茶', '咖啡', '饮料', '水', '水果', '零食', '面包', '蛋糕', '烧烤', '火锅', '小吃', '汉堡', '炸鸡', '披萨'],
  '交通': ['打车', '地铁', '公交', '车', '出租', '滴滴', '高铁', '火车', '机票', '飞机', '加油', '停车', '骑行', '共享单车', '通勤'],
  '购物': ['买', '购', '衣服', '鞋', '裤子', '裙子', '包', '化妆品', '护肤品', '手机', '电脑', '电子', '书', '日用品', '超市', '淘宝', '京东', '拼多多', '网购', '消费'],
  '娱乐': ['电影', '游戏', 'KTV', '唱歌', '旅游', '景点', '门票', '运动', '健身', '音乐', '视频', '会员', '订阅', '玩'],
  '住房': ['房租', '水电', '物业', '网费', '煤气', '天然气', '维修', '家居', '装修', '住宿'],
  '医疗': ['药', '医院', '门诊', '体检', '牙', '眼', '挂号', '医保'],
  '教育': ['课', '学习', '培训', '考试', '书费', '学费', '教材', '课程', '资料'],
  '通讯': ['话费', '流量', '宽带', '手机费', '上网'],
  '礼物': ['礼物', '送', '红包', '请客', '请', '女朋友', '男朋友', '生日', '节日', '花', '祝福'],
}

function inferCategory(text) {
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return category
    }
  }
  return '其他'
}

function isIncome(text) {
  const incomeWords = ['收入', '工资', '奖金', '红包收入', '兼职', '稿费', '报销', '退款', '理财收益', '利息', '赚', '发了']
  return incomeWords.some(w => text.includes(w))
}

function extractAmount(text) {
  // 匹配 "XX元" 模式
  const m = text.match(/(\d+(?:\.\d{1,2})?)\s*元/)
  if (m) return parseFloat(m[1])
  // 匹配 "XX块" 模式
  const m2 = text.match(/(\d+(?:\.\d{1,2})?)\s*块/)
  if (m2) return parseFloat(m2[1])
  return null
}

function extractDate(text) {
  const today = new Date()
  if (text.includes('昨天')) {
    const d = new Date(today); d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  }
  if (text.includes('前天')) {
    const d = new Date(today); d.setDate(d.getDate() - 2)
    return d.toISOString().slice(0, 10)
  }
  if (text.includes('今天')) {
    return today.toISOString().slice(0, 10)
  }
  return today.toISOString().slice(0, 10)
}

function localParse(deviceId, userMessage) {
  const text = userMessage
  const contextData = getContextData(deviceId)

  // 检测意图
  const queryWords = ['多少', '花了多少钱', '统计', '分析', '报告', '汇总', '消费结构', '趋势', '占比', '分类']
  const adviceWords = ['建议', '省钱', '规划', '理财', '怎么', '如何', '推荐', '帮助']
  const goalWords = ['目标', '存钱', '储蓄', '计划', '想买', '攒钱']

  const isQuery = queryWords.some(w => text.includes(w))
  const isAdvice = adviceWords.some(w => text.includes(w))
  const isGoal = goalWords.some(w => text.includes(w))

  const amount = extractAmount(text)
  const isInc = isIncome(text)

  // 查询类
  if (isQuery) {
    if (text.includes('月') || text.includes('花了多少钱') || text.includes('汇总')) {
      const s = contextData.monthlyStats
      const rate = s.income > 0 ? ((s.income - s.expense) / s.income * 100).toFixed(1) : 0
      return {
        intent: 'query',
        message: `📊 本月财务概览：\n收入：¥${s.income.toFixed(0)}\n支出：¥${s.expense.toFixed(0)}\n结余：¥${(s.income - s.expense).toFixed(0)}\n储蓄率：${rate}%\n\n共记录 ${contextData.recentRecords.length} 条消费，今日已支出 ¥${contextData.todayExpense.toFixed(0)}。继续保持哦~`,
        data: null
      }
    }
    if (text.includes('分类') || text.includes('占比') || text.includes('结构')) {
      const catSummary = contextData.recentRecords.reduce((acc, r) => {
        if (r.type === 'expense') {
          acc[r.category] = (acc[r.category] || 0) + r.amount
        }
        return acc
      }, {})
      const lines = Object.entries(catSummary).map(([k, v]) => `${k}: ¥${v.toFixed(0)}`).join('\n')
      return {
        intent: 'query',
        message: `📈 消费分类概览：\n${lines || '暂无数据'}\n\n可以在"消费分析"页面查看详细图表哦~`,
        data: null
      }
    }
    return {
      intent: 'query',
      message: `📊 本月已支出 ¥${contextData.monthlyStats.expense.toFixed(0)}，今日已支出 ¥${contextData.todayExpense.toFixed(0)}。有什么具体想了解的吗？`,
      data: null
    }
  }

  // 建议类
  if (isAdvice) {
    const s = contextData.monthlyStats
    let advice = '💡 基于你的消费情况：\n'
    if (s.expense > s.income * 0.7) {
      advice += '• 本月支出占比较高，建议控制非必要消费\n'
    } else {
      advice += '• 财务状况良好，储蓄率不错！\n'
    }
    advice += '• 可以设置月度预算来更好地控制支出\n'
    advice += '• 尝试记账每一笔消费，月底会更有收获\n'
    if (contextData.anomalies.length > 0) {
      advice += `• ⚠️ ${contextData.anomalies[0].category}消费环比增长较多，注意控制哦~\n`
    }
    return { intent: 'advice', message: advice, data: null }
  }

  // 目标类
  if (isGoal) {
    const goalAmount = extractAmount(text) || 1000
    const goalName = text.replace(/[0-9]/g, '').replace(/[.,，。元块]/g, '').replace(/我想|存钱|买|一个|新/g, '').trim() || '储蓄目标'
    return {
      intent: 'goal',
      message: `🎯 好的！我帮你记录了储蓄目标"${goalName}"，目标金额 ¥${goalAmount}。\n加油，一步步实现你的目标！💪`,
      data: { name: goalName, target_amount: goalAmount, deadline: null }
    }
  }

  // 记账类 - 有金额信息
  if (amount) {
    const category = inferCategory(text)
    const date = extractDate(text)
    const desc = text.replace(/[0-9.,，。元块]/g, '').replace(/(今天|昨天|前天|花了|消费|支出|用了)/g, '').trim() || category

    let emoticon = ''
    if (category === '餐饮') emoticon = '🍜'
    else if (category === '交通') emoticon = '🚗'
    else if (category === '购物') emoticon = '🛍️'
    else if (category === '娱乐') emoticon = '🎮'
    else if (category === '礼物') emoticon = '🎁'
    else emoticon = '📝'

    if (isInc) {
      return {
        intent: 'record',
        message: `✅ 已记录！收入 ${desc} ¥${amount.toFixed(2)}，今天是个好日子！🎉`,
        data: { type: 'income', amount, category, description: desc, date }
      }
    }

    return {
      intent: 'record',
      message: `✅ 已记录！${emoticon} ${category} ¥${amount.toFixed(2)}（${desc}），今日已支出 ¥${(contextData.todayExpense + amount).toFixed(0)}`,
      data: { type: 'expense', amount, category, description: desc, date }
    }
  }

  // 闲聊
  const greetings = ['你好', 'hi', 'hello', '嗨', '早', '在吗', '谢谢', '感谢']
  if (greetings.some(g => text.includes(g.toLowerCase()))) {
    return { intent: 'chat', message: '你好呀！😊 我是你的财务记账助手小财，随时准备帮你记账、查账、做规划~', data: null }
  }

  return {
    intent: 'chat',
    message: '你可以这样跟我说：\n• "今天午餐花了25元" — 快速记账\n• "这个月花了多少钱" — 查看汇总\n• "有什么省钱建议吗" — 获取建议\n• "我想存钱买个新手机" — 设定目标',
    data: null
  }
}

// ============ 主入口 ============

export async function processMessage(deviceId, userMessage) {
  // 如果没有配置 API Key，使用本地规则引擎
  if (!HAS_API_KEY) {
    return localParse(deviceId, userMessage)
  }

  const contextData = getContextData(deviceId)
  const memoryContext = getMemoryContext(deviceId)

  let memoryText = ''
  if (memoryContext.habits.length > 0) {
    memoryText = '\n## 用户消费习惯\n' + memoryContext.habits.join('\n')
  }
  if (memoryContext.goals.length > 0) {
    memoryText += '\n## 当前目标\n' + memoryContext.goals.map(g =>
      `${g.name}: 目标${g.target_amount}元, 已存${g.current_amount}元`
    ).join('\n')
  }

  const dataText = `
## 用户当前财务状况
- 本月收入: ${contextData.monthlyStats.income}元
- 本月支出: ${contextData.monthlyStats.expense}元
- 今日已支出: ${contextData.todayExpense}元

## 最近10条记录
${contextData.recentRecords.map(r =>
  `${r.date} ${r.type === 'income' ? '收入' : '支出'} ${r.category} ${r.amount}元 ${r.description || ''}`
).join('\n')}

## 预算状态
${contextData.budgets.map(b =>
  `${b.category}: 预算${b.budget}元, 已用${b.spent}元, 剩余${b.remaining}元 (${b.percent}%)`
).join('\n') || '未设置预算'}

## 异常提醒
${contextData.anomalies.map(a =>
  `${a.category}消费环比增长${a.change}% (上月${a.previous}元 → 本月${a.current}元)`
).join('\n') || '无异常'}
`

  const today = new Date().toISOString().slice(0, 10)

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + memoryText + dataText,
      messages: [{
        role: 'user',
        content: `今天的日期是${today}。\n用户说: "${userMessage}"\n\n请分析用户意图并返回JSON响应。`
      }]
    })

    const text = response.content[0].text
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { intent: 'chat', message: '抱歉，我没太理解你的意思，可以换个说法试试吗？😊', data: null }
    }

    try {
      return JSON.parse(jsonMatch[0])
    } catch {
      return { intent: 'chat', message: text, data: null }
    }
  } catch (error) {
    console.error('Claude API error, falling back to local:', error.message)
    return localParse(deviceId, userMessage)
  }
}
