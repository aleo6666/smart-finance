import { randomUUID } from 'crypto'
import { cacheSet, cacheGet, cacheDelete } from '../redis.js'

export const OCR_SESSION_TTL_SECONDS = 30 * 60

export function createOcrSessionKey(userId, ocrSessionId) {
  return `ocr:session:${userId}:${ocrSessionId}`
}

function normalizeRecords(records) {
  return Array.isArray(records) ? records : []
}

export async function saveOcrSession({
  userId,
  file,
  result,
  sessionIdFactory = randomUUID,
  now = () => new Date(),
  cache = { set: cacheSet }
}) {
  const ocrSessionId = sessionIdFactory()
  const session = {
    userId,
    image: {
      path: file?.path || '',
      mimeType: file?.mimetype || '',
      size: file?.size || 0
    },
    summary: result?.summary || '',
    totalAmount: Number(result?.totalAmount || 0),
    records: normalizeRecords(result?.records),
    createdAt: now().toISOString()
  }

  await cache.set(createOcrSessionKey(userId, ocrSessionId), session, OCR_SESSION_TTL_SECONDS)

  return {
    ocrSessionId,
    expiresInSeconds: OCR_SESSION_TTL_SECONDS,
    session
  }
}

export async function readOcrSession({
  userId,
  ocrSessionId,
  cache = { get: cacheGet }
}) {
  if (!ocrSessionId) return null
  return cache.get(createOcrSessionKey(userId, ocrSessionId))
}

export async function clearOcrSession({
  userId,
  ocrSessionId,
  cache = { delete: cacheDelete }
}) {
  if (!ocrSessionId) return
  await cache.delete(createOcrSessionKey(userId, ocrSessionId))
}
