import { randomUUID } from 'crypto'

function normalizeRecordFields(record) {
  return {
    type: record.type || 'expense',
    amount: Number(record.amount),
    category: record.category || '其他',
    description: record.description || '',
    date: record.date || new Date().toISOString().slice(0, 10),
    ledgerId: record.ledgerId || null,
    currency: record.currency || 'CNY',
    merchant: record.merchant || null,
    project: record.project || null,
    member: record.member || null
  }
}

export function createRecordTaskFromNlu({ userId, deviceId, message, nluResult }) {
  const data = nluResult?.data
  if (nluResult?.intent !== 'record') return null

  // 多笔：data.records 数组 → payload.records 批量入库
  if (Array.isArray(data?.records) && data.records.length > 0) {
    return {
      taskId: randomUUID(),
      agentType: 'recorder',
      intent: 'record',
      payload: {
        intent: 'record',
        userId,
        deviceId,
        message,
        records: data.records.map(normalizeRecordFields)
      }
    }
  }

  if (!data?.amount) return null

  return {
    taskId: randomUUID(),
    agentType: 'recorder',
    intent: 'record',
    payload: {
      intent: 'record',
      userId,
      deviceId,
      message,
      record: normalizeRecordFields(data)
    }
  }
}
