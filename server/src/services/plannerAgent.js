import { randomUUID } from 'crypto'

export function createRecordTaskFromNlu({ userId, deviceId, message, nluResult }) {
  const data = nluResult?.data
  if (nluResult?.intent !== 'record' || !data?.amount) return null

  return {
    taskId: randomUUID(),
    agentType: 'recorder',
    intent: 'record',
    payload: {
      intent: 'record',
      userId,
      deviceId,
      message,
      record: {
        type: data.type || 'expense',
        amount: Number(data.amount),
        category: data.category || '其他',
        description: data.description || '',
        date: data.date || new Date().toISOString().slice(0, 10),
        ledgerId: data.ledgerId || null,
        currency: data.currency || 'CNY',
        merchant: data.merchant || null,
        project: data.project || null,
        member: data.member || null
      }
    }
  }
}
