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
    date: record.date || new Date().toISOString().slice(0, 10)
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

  try {
    const recordInput = normalizeRecord(task.payload)
    const saved = await repository.insertRecord(recordInput)

    let vectorIndexed = true
    if (billVectorWriteEnabled) {
      try {
        await vectorMemory.embedRecord(saved)
      } catch (error) {
        console.warn(`[Recorder] vector embed skipped for record id=${saved.id}: ${error.message}`)
        vectorIndexed = false
      }
    }

    const monitorResult = await monitorAgent.checkBudgetAfterRecord({ record: saved })
    await observeService.recordAgentEvent({
      userId: saved.user_id,
      callType: 'record',
      latencyMs: Date.now() - started,
      status: 'succeeded',
      vectorIndexed
    })

    return {
      recordIds: [saved.id],
      summary: `recorded ${saved.amount}`,
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
