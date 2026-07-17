import db from '../db.js'
import { embedRecord } from './vectorMemory.js'
import { checkBudgetAfterRecord } from './monitorAgent.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function cleanText(value) {
  return String(value || '').trim()
}

export function normalizeOcrRecord(input) {
  const amount = Number(input?.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须大于 0')
  if (amount > 100000) throw new Error('金额不能超过 100000')

  const category = cleanText(input?.category)
  if (!category) throw new Error('分类不能为空')

  const date = cleanText(input?.date)
  if (!DATE_PATTERN.test(date)) throw new Error('日期格式必须是 YYYY-MM-DD')

  const type = input?.type === 'income' ? 'income' : 'expense'

  return {
    type,
    amount,
    currency: 'CNY',
    amount_cny: amount,
    category,
    description: cleanText(input?.description) || category,
    merchant: cleanText(input?.merchant) || null,
    date
  }
}

function comparable(record) {
  return {
    amount: Number(record?.amount || 0),
    category: cleanText(record?.category),
    date: cleanText(record?.date),
    merchant: cleanText(record?.merchant),
    description: cleanText(record?.description)
  }
}

export function isUserCorrected(original, confirmed) {
  const left = comparable(original)
  const right = comparable(confirmed)
  return left.amount !== right.amount ||
    left.category !== right.category ||
    left.date !== right.date ||
    left.merchant !== right.merchant ||
    left.description !== right.description
}

export function createOcrConfirmRepository(dbClient = db) {
  return {
    async transaction(work) {
      return dbClient.transaction(work)
    },
    async insertRecord(record, trx) {
      const [id] = await trx('records').insert(record)
      return id
    },
    async fetchRecord(id, userId, trx) {
      return trx('records').where({ id, user_id: userId }).first()
    },
    async insertEvaluation(evaluation, trx) {
      await trx('ocr_evaluations').insert(evaluation)
    }
  }
}

export async function saveConfirmedOcrRecords({
  userId,
  deviceId,
  session,
  confirmedRecords,
  repository = createOcrConfirmRepository(),
  embedRecordFn = embedRecord,
  checkBudgetAfterRecordFn = checkBudgetAfterRecord,
  logger = console
}) {
  const normalizedRecords = (Array.isArray(confirmedRecords) ? confirmedRecords : []).map(normalizeOcrRecord)
  if (normalizedRecords.length === 0) throw new Error('没有可保存的确认记录')

  const savedRecords = []
  const originalRecords = Array.isArray(session?.records) ? session.records : []

  await repository.transaction(async trx => {
    for (const [index, record] of normalizedRecords.entries()) {
      const row = {
        device_id: deviceId || `user-${userId}`,
        user_id: userId,
        ledger_id: null,
        type: record.type,
        amount: record.amount,
        currency: record.currency,
        amount_cny: record.amount_cny,
        category: record.category,
        description: record.description,
        merchant: record.merchant,
        date: record.date
      }

      const id = await repository.insertRecord(row, trx)
      const saved = await repository.fetchRecord(id, userId, trx)
      savedRecords.push(saved)

      const original = originalRecords[index] || {}
      const corrected = isUserCorrected(original, record)
      await repository.insertEvaluation({
        record_id: id,
        user_id: userId,
        ocr_result: JSON.stringify(original),
        user_confirmed: 1,
        user_corrected: corrected ? 1 : 0,
        corrected_category: record.category,
        corrected_amount: record.amount,
        ocr_correct: corrected ? 0 : 1,
        confirmed_at: new Date()
      }, trx)
    }
  })

  for (const record of savedRecords) {
    await embedRecordFn(record).catch(error => logger.warn('[Vector] OCR embed skipped:', error.message))
    await checkBudgetAfterRecordFn({ record }).catch(error => logger.warn('[Monitor] OCR skipped:', error.message))
  }

  return { records: savedRecords, count: savedRecords.length }
}
