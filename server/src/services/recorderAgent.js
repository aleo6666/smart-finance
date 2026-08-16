import db from '../db.js'
import * as defaultVectorMemory from './vectorMemory.js'
import * as defaultMonitorAgent from './monitorAgent.js'
import * as defaultObserveService from './observeService.js'

export function createRecordRepository(dbClient = db) {
  return {
    async insertRecord(record) {
      const [id] = await dbClient('records').insert(record)
      const saved = await dbClient('records').where({ id }).first()
      return saved || { id, ...record }
    }
  }
}

function normalizeRecord(payload) {
  const record = payload.record
  const amount = Number(record.amount)
  const currency = record.currency || 'CNY'

  // 统一日期格式：把 ISO 格式（带 T/Z）转换成 YYYY-MM-DD
  let date = record.date
  if (date && typeof date === 'string') {
    // 如果是 ISO 格式，提取日期部分
    if (date.includes('T')) {
      date = date.split('T')[0]
    }
    // 确保格式正确
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      try {
        const d = new Date(date)
        if (!isNaN(d.getTime())) {
          date = d.toISOString().slice(0, 10)
        }
      } catch {
        // 解析失败，用当前日期
        date = new Date().toISOString().slice(0, 10)
      }
    }
  }

  return {
    device_id: payload.deviceId || `user-${payload.userId}`,
    user_id: payload.userId || null,
    ledger_id: record.ledgerId || record.ledger_id || null,
    type: record.type || 'expense',
    amount,
    currency,
    amount_cny: record.amount_cny ?? amount,
    category: record.category || '其他',
    description: record.description || '',
    merchant: record.merchant || null,
    project: record.project || null,
    member: record.member || null,
    date: date || new Date().toISOString().slice(0, 10)
  }
}

export async function recordFromPlannerTask({
  task,
  repository = createRecordRepository(),
  vectorMemory = defaultVectorMemory,
  monitorAgent = defaultMonitorAgent,
  observeService = defaultObserveService,
  billVectorWriteEnabled = false
}) {
  const started = Date.now()
  const payload = task.payload || {}
  const recordInputs = Array.isArray(payload.records) && payload.records.length > 0
    ? payload.records
    : [payload.record]

  try {
    const savedList = []
    let vectorIndexed = true
    let monitorResult = null

    for (const record of recordInputs) {
      const recordInput = normalizeRecord({ ...payload, record })
      const saved = await repository.insertRecord(recordInput)
      savedList.push(saved)

      if (billVectorWriteEnabled) {
        try {
          await vectorMemory.embedRecord(saved)
        } catch (error) {
          console.warn(`[Recorder] vector embed skipped for record id=${saved.id}: ${error.message}`)
          vectorIndexed = false
        }
      }

      monitorResult = await monitorAgent.checkBudgetAfterRecord({ record: saved })
    }

    await observeService.recordAgentEvent({
      userId: savedList[0]?.user_id ?? payload.userId ?? null,
      callType: 'record',
      latencyMs: Date.now() - started,
      status: 'succeeded',
      vectorIndexed
    })

    return {
      recordIds: savedList.map(saved => saved.id),
      summary: savedList.length === 1
        ? `recorded ${savedList[0].amount}`
        : `recorded ${savedList.length} records`,
      monitor: monitorResult,
      vectorIndexed
    }
  } catch (error) {
    await observeService.recordAgentEvent({
      userId: task.payload?.userId || null,
      callType: 'record',
      latencyMs: Date.now() - started,
      success: false,
      errorMessage: error.message
    }).catch(() => {})
    throw error
  }
}
