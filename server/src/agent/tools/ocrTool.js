import { Model, PaddleOCRClient } from '@paddleocr/api-sdk'
import { tool } from 'langchain'
import { z } from 'zod'
import defaultConfig from '../../config.js'
import { normalizeTrustedUserId } from '../runtime.js'

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export class OcrToolError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'OcrToolError'
    this.code = code
    this.statusCode = statusCode
    this.expose = true
  }
}

export function manualOcrFallback(reason) {
  return {
    status: 'manual_fallback',
    reason,
    form: {
      type: 'expense',
      amount: null,
      currency: 'CNY',
      category: '',
      description: '',
      merchant: '',
      date: ''
    }
  }
}

function boundedText(value, max, { required = false } = {}) {
  const normalized = String(value ?? '').trim()
  if ((required && !normalized) || normalized.length > max) {
    throw new OcrToolError('OCR_UNAVAILABLE', 'OCR unavailable', 503)
  }
  return normalized
}

function validDate(value) {
  const date = boundedText(value, 10, { required: true })
  if (!DATE_PATTERN.test(date)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
}

export function normalizeOcrPreview(input) {
  const amount = Number(input?.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new OcrToolError('OCR_UNAVAILABLE', 'OCR unavailable', 503)
  }
  if (!validDate(input?.date)) {
    throw new OcrToolError('OCR_UNAVAILABLE', 'OCR unavailable', 503)
  }
  const category = boundedText(input?.category, 64, { required: true })
  const description = boundedText(input?.description, 500) || category
  const merchant = boundedText(input?.merchant, 128)
  const currency = String(input?.currency || 'CNY').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new OcrToolError('OCR_UNAVAILABLE', 'OCR unavailable', 503)
  }
  return {
    type: input?.type === 'income' ? 'income' : 'expense',
    amount,
    currency,
    category,
    description,
    date: input.date,
    merchant: merchant || null
  }
}

export function normalizePaddleOcrResult(raw) {
  const candidate = raw?.preview ??
    raw?.record ??
    raw?.records?.[0] ??
    raw?.pages?.[0]?.prunedResult
  return normalizeOcrPreview(candidate)
}

export function createPaddleOcrClient({
  config = defaultConfig,
  ClientClass = PaddleOCRClient
} = {}) {
  const client = new ClientClass({
    token: config.paddleOcr.accessToken,
    requestTimeout: config.paddleOcr.requestTimeoutMs,
    pollTimeout: config.paddleOcr.pollTimeoutMs
  })
  return {
    async parse(input, { signal } = {}) {
      if (!input?.filePath) {
        throw new OcrToolError('OCR_UNAVAILABLE', 'OCR unavailable', 503)
      }
      return client.ocr({
        model: Model.PPOCRv5,
        filePath: input.filePath
      }, { signal })
    }
  }
}

function parseInput(upload) {
  if (Buffer.isBuffer(upload?.bytes) || upload?.bytes instanceof Uint8Array) {
    return { bytes: upload.bytes }
  }
  if (typeof upload?.path === 'string' && upload.path) {
    return { filePath: upload.path }
  }
  throw new OcrToolError('UPLOAD_NOT_FOUND', 'upload not found', 404)
}

async function resolveOwnedUpload(resolveUpload, { uploadId, userId }) {
  let upload
  try {
    upload = await resolveUpload({ uploadId, userId })
  } catch {
    throw new OcrToolError('UPLOAD_NOT_FOUND', 'upload not found', 404)
  }
  if (!upload) {
    throw new OcrToolError('UPLOAD_NOT_FOUND', 'upload not found', 404)
  }
  let ownerId
  try {
    ownerId = normalizeTrustedUserId(upload.userId)
  } catch {
    throw new OcrToolError('FORBIDDEN', 'forbidden', 403)
  }
  if (ownerId !== userId) {
    throw new OcrToolError('FORBIDDEN', 'forbidden', 403)
  }
  return upload
}

async function withTimeout(operation, timeoutMs) {
  let timeout
  const controller = new AbortController()
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new OcrToolError('OCR_UNAVAILABLE', 'OCR unavailable', 503))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export function createOcrTool({
  runtime,
  enabled = defaultConfig.agent.paddleOcrEnabled,
  client = createPaddleOcrClient(),
  resolveUpload,
  normalize = normalizePaddleOcrResult,
  timeoutMs = defaultConfig.paddleOcr.timeoutMs ??
    defaultConfig.paddleOcr.requestTimeoutMs
}) {
  const userId = normalizeTrustedUserId(runtime?.userId)
  return tool(async ({ uploadId }) => {
    if (!enabled) return manualOcrFallback('OCR_DISABLED')
    if (typeof resolveUpload !== 'function') {
      return manualOcrFallback('OCR_UNAVAILABLE')
    }

    const upload = await resolveOwnedUpload(resolveUpload, { uploadId, userId })
    const internalInput = parseInput(upload)
    try {
      const raw = await withTimeout(
        signal => client.parse(internalInput, { signal }),
        timeoutMs
      )
      const preview = normalizeOcrPreview(await normalize(raw))
      return {
        status: 'needs_confirmation',
        preview,
        source: { uploadId, provider: 'paddleocr' }
      }
    } catch {
      return manualOcrFallback('OCR_UNAVAILABLE')
    }
  }, {
    name: 'ocr_receipt',
    description: '识别当前用户已上传的小票并返回待确认预览，不直接写账',
    schema: z.object({
      uploadId: z.string().regex(UPLOAD_ID_PATTERN)
    }).strict()
  })
}
