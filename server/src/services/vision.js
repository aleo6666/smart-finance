import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY
  if (key && key !== 'your-api-key-here') {
    return new Anthropic({ apiKey: key })
  }
  return null
}

const VISION_PROMPT = `你是一个财务记账助手，请分析这张购物小票/收据/订单截图。

请提取所有消费项目，返回严格的JSON格式（不要包含任何其他文字，只输出JSON）：
{
  "records": [
    {
      "type": "expense",
      "amount": 数字,
      "category": "分类",
      "description": "描述",
      "date": "日期(YYYY-MM-DD)"
    }
  ],
  "summary": "一句话总结本次消费",
  "totalAmount": 总金额
}

规则：
- 类别从以下选择：餐饮、交通、购物、娱乐、住房、医疗、教育、通讯、礼物、其他
- 如果能看出商家类型，自动推断合适的类别（如超市→购物，餐厅→餐饮）
- 金额单位默认为"元"
- 日期默认今天，小票上有日期则用小票日期
- 如果图片不是购物小票或收据，返回空 records: []，summary 中说明原因
- 网购订单截图也可以识别，提取已付款的商品
- 多个商品可以合并为一条记录（类别相同），也可以分开列出`

export async function scanReceipt(imagePath, _deviceId) {
  const anthropic = getClient()

  if (!anthropic) {
    return {
      records: [],
      summary: '请配置 Claude API Key 以启用识图功能。',
      totalAmount: 0
    }
  }

  try {
    const imageBuffer = fs.readFileSync(imagePath)

    // 通过文件头 magic bytes 判断图片类型（multer 会去掉扩展名）
    const b = imageBuffer
    let mediaType = 'image/jpeg'
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) mediaType = 'image/png'
    else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) mediaType = 'image/gif'
    else if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) mediaType = 'image/webp'

    const base64 = imageBuffer.toString('base64')
    const today = new Date().toISOString().slice(0, 10)

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      system: VISION_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `请分析这张购物小票/收据截图，提取其中的消费信息。今天的日期是${today}。`
          }
        ]
      }]
    })

    // claude-sonnet-4-6 可能返回 thinking 块，找到 text 块
    const textBlock = response.content.find(c => c.type === 'text')
    const text = textBlock ? textBlock.text : (response.content[0]?.text || '')

    if (!text) {
      console.error('[Vision] 回复无文本块:', JSON.stringify(response.content.map(c => c.type)))
      return { records: [], summary: 'AI 未返回可识别的文本。请重试。', totalAmount: 0 }
    }

    console.log('[Vision] 识别文本:', text.slice(0, 200))

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { records: [], summary: '未能识别图片中的消费信息，请确认图片内容清晰可见。', totalAmount: 0 }
    }

    const result = JSON.parse(jsonMatch[0])
    return {
      records: result.records || [],
      summary: result.summary || '已识别消费',
      totalAmount: result.totalAmount || 0
    }
  } catch (error) {
    console.error('[Vision] 识图失败:', error.status || '', error.message)
    return {
      records: [],
      summary: '识别失败: ' + (error.message || '未知错误'),
      totalAmount: 0
    }
  }
}
