import { createHash } from 'node:crypto'
import db from '../db.js'
import { embedRecord } from './vectorMemory.js'
import { checkBudgetAfterRecord } from './monitorAgent.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export class OcrConfirmError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'OcrConfirmError'
    this.code = code
    this.statusCode = statusCode
    this.expose = true
  }
}

export function createOcrConfirmOperationId({ userId, uploadId }) {
  const digest = createHash('sha256')
    .update(`${Number(userId)}:${String(uploadId || '')}`)
    .digest('hex')
    .slice(0, 48)
  return `ocr:${digest}`
}

function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(
    value,
    (_key, item) => typeof item === 'bigint' ? item.toString() : item
  ))
}

function cleanText(value) {
  return String(value || '').trim()
}

function boundedText(value, max, fieldName, { required = false } = {}) {
  const normalized = cleanText(value)
  if ((required && !normalized) || normalized.length > max) {
    throw new Error(`${fieldName} is invalid`)
  }
  return normalized
}

export function normalizeOcrRecord(input) {
  const amount = Number(input?.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须大于 0')
  if (amount > 100000) throw new Error('金额不能超过 100000')

  const category = boundedText(input?.category, 64, 'category', { required: true })
  if (!category) throw new Error('分类不能为空')

  const date = boundedText(input?.date, 10, 'date', { required: true })
  if (!DATE_PATTERN.test(date)) throw new Error('日期格式必须是 YYYY-MM-DD')

  const parsedDate = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('date must be YYYY-MM-DD')
  }

  const type = input?.type === 'income' ? 'income' : 'expense'

  return {
    type,
    amount,
    currency: 'CNY',
    amount_cny: amount,
    category,
    description: boundedText(input?.description, 500, 'description') || category,
    merchant: boundedText(input?.merchant, 128, 'merchant') || null,
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

async function persistConfirmedOcrRecords({
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
    await embedRecordFn(record).catch(() => logger.warn('[Vector] OCR embed skipped'))
    await checkBudgetAfterRecordFn({ record }).catch(() => logger.warn('[Monitor] OCR skipped'))
  }

  return { records: savedRecords, count: savedRecords.length }
}

export async function saveConfirmedOcrRecords({
  userId,
  deviceId,
  session,
  uploadId,
  operationId,
  operationStore,
  confirmedRecords,
  repository = createOcrConfirmRepository(),
  embedRecordFn = embedRecord,
  checkBudgetAfterRecordFn = checkBudgetAfterRecord,
  logger = console
}) {
  if (session?.userId != null && Number(session.userId) !== Number(userId)) {
    throw new OcrConfirmError('FORBIDDEN', 'forbidden', 403)
  }

  const records = Array.isArray(confirmedRecords) ? confirmedRecords : []
  if (records.length === 0 || records.length > 50) {
    throw new OcrConfirmError('INVALID_OCR_CONFIRMATION', 'invalid OCR confirmation', 400)
  }
  let normalizedRecords
  try {
    normalizedRecords = records.map(normalizeOcrRecord)
  } catch {
    throw new OcrConfirmError('INVALID_OCR_CONFIRMATION', 'invalid OCR confirmation', 400)
  }

  if (!operationStore) {
    return persistConfirmedOcrRecords({
      userId,
      deviceId,
      session,
      confirmedRecords: normalizedRecords,
      repository,
      embedRecordFn,
      checkBudgetAfterRecordFn,
      logger
    })
  }

  if (session?.userId == null || typeof uploadId !== 'string' || !uploadId) {
    throw new OcrConfirmError('INVALID_OCR_CONFIRMATION', 'invalid OCR confirmation', 400)
  }
  const trustedOperationId = createOcrConfirmOperationId({ userId, uploadId })
  if (operationId !== trustedOperationId) {
    throw new OcrConfirmError('INVALID_OPERATION', 'invalid operation', 400)
  }
  const claim = await operationStore.claim({
    userId,
    operationId: trustedOperationId,
    operationType: 'ocr_confirm',
    input: {
      uploadId,
      preview: normalizedRecords
    }
  })
  if (claim.status === 'succeeded') return claim.result
  if (claim.status === 'in_progress') {
    return { status: 'in_progress', records: [], count: 0 }
  }
  if (claim.status !== 'owner') {
    throw new OcrConfirmError('OCR_CONFIRM_FAILED', 'OCR confirmation unavailable', 503)
  }

  try {
    const persistedResult = await persistConfirmedOcrRecords({
      userId,
      deviceId,
      session,
      confirmedRecords: normalizedRecords,
      repository,
      embedRecordFn,
      checkBudgetAfterRecordFn,
      logger
    })
    const result = toJsonSafe(persistedResult)
    await operationStore.succeed({
      userId,
      operationId: trustedOperationId,
      inputHash: claim.inputHash,
      result
    })
    return result
  } catch {
    await operationStore.fail({
      userId,
      operationId: trustedOperationId,
      inputHash: claim.inputHash,
      errorCode: 'OCR_CONFIRM_FAILED'
    }).catch(() => {})
    throw new OcrConfirmError('OCR_CONFIRM_FAILED', 'OCR confirmation unavailable', 503)
  }
}
