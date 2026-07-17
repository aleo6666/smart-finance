import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OCR_SESSION_TTL_SECONDS,
  createOcrSessionKey,
  saveOcrSession,
  readOcrSession,
  clearOcrSession
} from '../src/services/ocrSession.js'

function createFakeCache() {
  const values = new Map()
  return {
    values,
    async set(key, value, ttlSeconds) {
      values.set(key, { value, ttlSeconds })
    },
    async get(key) {
      return values.get(key)?.value || null
    },
    async delete(key) {
      values.delete(key)
    }
  }
}

test('createOcrSessionKey scopes sessions by user id and session id', () => {
  assert.equal(createOcrSessionKey(7, 'abc'), 'ocr:session:7:abc')
})

test('saveOcrSession stores OCR result with 30 minute TTL', async () => {
  const cache = createFakeCache()

  const saved = await saveOcrSession({
    userId: 7,
    file: { path: 'uploads/a.png', mimetype: 'image/png', size: 123 },
    result: {
      summary: '识别到 1 条消费记录',
      totalAmount: 25,
      records: [{ amount: 25, category: '餐饮', date: '2026-07-17' }]
    },
    sessionIdFactory: () => 'session-1',
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    cache
  })

  assert.equal(saved.ocrSessionId, 'session-1')
  assert.equal(saved.expiresInSeconds, OCR_SESSION_TTL_SECONDS)
  assert.equal(cache.values.get('ocr:session:7:session-1').ttlSeconds, 1800)

  const session = await readOcrSession({
    userId: 7,
    ocrSessionId: 'session-1',
    cache
  })

  assert.equal(session.userId, 7)
  assert.equal(session.summary, '识别到 1 条消费记录')
  assert.equal(session.records[0].amount, 25)
  assert.equal(session.createdAt, '2026-07-17T00:00:00.000Z')
})

test('clearOcrSession deletes only the scoped user session', async () => {
  const cache = createFakeCache()
  await saveOcrSession({
    userId: 7,
    file: { path: 'uploads/a.png', mimetype: 'image/png', size: 123 },
    result: { summary: 'ok', totalAmount: 1, records: [{ amount: 1, category: '餐饮', date: '2026-07-17' }] },
    sessionIdFactory: () => 'session-1',
    cache
  })

  await clearOcrSession({ userId: 7, ocrSessionId: 'session-1', cache })

  assert.equal(await readOcrSession({ userId: 7, ocrSessionId: 'session-1', cache }), null)
})
