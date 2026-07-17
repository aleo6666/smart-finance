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

const INCOME_WORDS = ['收入', '工资', '奖金', '报销', '退款', '兼职', '利息', '收到了', '收到']
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
  if (text.includes('昨天')) {
    const d = new Date(today)
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  }
  if (text.includes('前天')) {
    const d = new Date(today)
    d.setDate(d.getDate() - 2)
    return d.toISOString().slice(0, 10)
  }
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

function localParse(message) {
  const text = String(message || '')
  const amount = extractAmount(text)

  if (amount) {
    const type = isIncome(text) ? 'income' : 'expense'
    const category = type === 'income' ? '收入' : inferCategory(text)
    const description = cleanDescription(text) || category
    return {
      intent: 'record',
      message: `已记录：${type === 'income' ? '收入' : '支出'} ${description} ¥${amount.toFixed(2)}`,
      data: {
        type,
        amount,
        category,
        description,
        date: extractDate(text)
      }
    }
  }

  if (GOAL_WORDS.some(word => text.includes(word))) {
    return {
      intent: 'goal',
      message: '可以，我会帮你记录这个目标。',
      data: { name: cleanDescription(text) || '储蓄目标', target_amount: 1000, deadline: null }
    }
  }

  if (QUERY_WORDS.some(word => text.includes(word))) {
    return { intent: 'query', message: '我可以帮你查看消费统计。', data: null }
  }

  if (ADVICE_WORDS.some(word => text.includes(word))) {
    return { intent: 'advice', message: '建议先保持连续记账，再根据月度分类占比优化预算。', data: null }
  }

  return {
    intent: 'chat',
    message: '你可以告诉我一笔消费，比如“今天午饭花了25元”。',
    data: null
  }
}

export async function processMessage(_identity, userMessage) {
  return localParse(userMessage)
}
