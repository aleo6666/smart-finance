export function createRagService({ retrieveSimilar, lmStudioClient, settings }) {
  async function answer({ question, userId, hints = {}, baseMessage = '' }) {
    if (!settings.enabled) {
      return { message: baseMessage, sources: [], records: 0 }
    }

    let records
    try {
      records = await retrieveSimilar(question, { userId, ...hints, limit: settings.topK })
    } catch (error) {
      console.warn('[RagService] retrieve failed:', error.message)
      return { message: baseMessage, sources: [], records: 0 }
    }

    if (!records || !records.length) {
      return { message: baseMessage, sources: [], records: 0 }
    }

    const systemMsg = {
      role: 'system',
      content: '你是一个个人财务助手。请基于用户提供的账目记录回答问题。不得编造不存在的账目，不得自行替代数据库完成精确求和，证据不足时应说明无法判断。'
    }

    let context = ''
    let includedCount = 0
    const maxChars = settings.maxContextChars

    for (const record of records) {
      const row = `记录ID: ${record.recordId} | 日期: ${record.date} | 分类: ${record.category} | 金额: ${Number(record.amount).toFixed(2)} | 商家: ${record.merchant || ''} | 描述: ${record.description || ''}\n`
      if (context.length + row.length > maxChars) break
      context += row
      includedCount++
    }

    if (includedCount === 0) {
      return { message: baseMessage, sources: [], records: 0 }
    }

    const userMsg = {
      role: 'user',
      content: `问题：${question}\n\n相关账目记录（共 ${includedCount} 条）：\n${context}\n请基于以上记录回答用户的问题。`
    }

    try {
      const message = await lmStudioClient.chat([systemMsg, userMsg])
      const sources = [...new Set(records.slice(0, includedCount).map(r => r.recordId))]
      return { message, sources, records: includedCount }
    } catch (error) {
      console.warn('[RagService] LM Studio chat failed:', error.message)
      return { message: baseMessage, sources: [], records: 0 }
    }
  }

  return { answer }
}
