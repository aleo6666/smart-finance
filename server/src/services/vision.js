import fs from 'fs'
import config from '../config.js'

const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const VALID_CATEGORIES = ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']

const OCR_PROMPT = `你是一个财务记账 OCR 助手。请读取图片中的支付、消费、小票或收据文字，提取消费记录。

只输出严格 JSON，不要 markdown：
{"records":[{"type":"expense","amount":数字,"category":"分类","description":"简短描述","date":"YYYY-MM-DD","merchant":"商家名称"}],"summary":"一句话总结"}

规则：
- amount 必须来自图片中的真实金额。
- category 只能从 餐饮/交通/购物/娱乐/住房/医疗/教育/通讯/礼物/其他 中选择。
- date 转为 YYYY-MM-DD；缺失时使用当前日期。
- 图片不是消费凭证时返回 {"records":[],"summary":"未识别到消费记录"}。
- 不要把“商家名称”“描述”等占位词当成真实数据。`

function detectMediaType(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp'
  return 'image/jpeg'
}

export async function scanReceipt(imagePath, _userId, {
  zhipuApiKey = config.ai.zhipuApiKey,
  fetchImpl = fetch
} = {}) {
  try {
    const imageBuffer = fs.readFileSync(imagePath)
    if (imageBuffer.length < 200) {
      return { records: [], summary: '图片文件过小，请上传清晰完整的截图。', totalAmount: 0 }
    }

    if (!zhipuApiKey) {
      return { records: [], summary: '未配置图片识别服务，请配置 ZHIPU_API_KEY 后重试。', totalAmount: 0 }
    }

    const mediaType = detectMediaType(imageBuffer)
    const base64 = imageBuffer.toString('base64')
    const zhipuResult = await callZhipu({ base64, mediaType, apiKey: zhipuApiKey, fetchImpl })
    return zhipuResult || {
      records: [],
      summary: '图片识别失败。请确认图片清晰完整，或手动输入消费记录。',
      totalAmount: 0
    }
  } catch (error) {
    console.error('[Vision] 异常:', error.message)
    return { records: [], summary: `识别出错: ${error.message?.slice(0, 80) || '未知错误'}`, totalAmount: 0 }
  }
}

async function callZhipu({ base64, mediaType, apiKey, fetchImpl }) {
  const body = {
    model: 'glm-4v-flash',
    max_tokens: 800,
    temperature: 0.1,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text: OCR_PROMPT }
      ]
    }]
  }

  try {
    const res = await fetchImpl(ZHIPU_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })

    if (!res.ok) return null

    const json = await res.json()
    const text = json.choices?.[0]?.message?.content || ''
    const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const bracketMatch = text.match(/\{[\s\S]*\}/)
    const jsonStr = mdMatch ? mdMatch[1] : (bracketMatch ? bracketMatch[0] : text)
    return validateOcrResult(JSON.parse(jsonStr))
  } catch (error) {
    console.error('[Vision] 智谱解析失败:', error.message)
    return null
  }
}

export function validateOcrResult(result) {
  if (!result || !Array.isArray(result.records)) return null
  if (result.records.length === 0) {
    return { records: [], summary: result.summary || '未识别到消费记录', totalAmount: 0 }
  }

  const clean = []
  for (const input of result.records) {
    const record = { ...input }
    if (typeof record.amount === 'string') record.amount = parseFloat(record.amount)
    if (!record.amount || record.amount <= 0 || record.amount > 100000 || Number.isNaN(record.amount)) continue
    if (!record.date) record.date = new Date().toISOString().slice(0, 10)
    if (!record.category || !VALID_CATEGORIES.includes(record.category)) record.category = '其他'

    const description = String(record.description || '').trim()
    const merchant = String(record.merchant || '').trim()
    clean.push({
      type: record.type === 'income' ? 'income' : 'expense',
      amount: Number(record.amount),
      category: record.category,
      description: description || record.category,
      date: String(record.date).slice(0, 10),
      merchant
    })
  }

  if (clean.length === 0) return { records: [], summary: '图片中未识别到有效的消费记录', totalAmount: 0 }
  const total = clean.reduce((sum, record) => sum + record.amount, 0)
  return {
    records: clean,
    summary: result.summary || `识别到 ${clean.length} 条消费记录，合计 ¥${total.toFixed(2)}`,
    totalAmount: Math.round(total * 100) / 100
  }
}
