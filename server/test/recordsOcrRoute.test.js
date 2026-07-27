import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createRecordsRouter } from '../src/routes/records.js'
import { signToken } from '../src/middleware/auth.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

test('POST /api/records/ocr returns OCR session and does not insert records', async () => {
  const calls = { scanned: 0, savedSession: 0, confirmed: 0 }
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    scanReceiptFn: async imagePath => {
      calls.scanned += 1
      assert.ok(imagePath)
      return {
        summary: '识别到 1 条消费记录',
        totalAmount: 25,
        records: [{ amount: 25, category: '餐饮', date: '2026-07-17', description: '午餐' }]
      }
    },
    ocrSessionService: {
      saveOcrSession: async input => {
        calls.savedSession += 1
        assert.equal(input.userId, 7)
        return { ocrSessionId: 'session-1', expiresInSeconds: 1800, session: input.result }
      },
      readOcrSession: async () => null,
      clearOcrSession: async () => {}
    },
    ocrConfirmService: {
      saveConfirmedOcrRecords: async () => {
        calls.confirmed += 1
        return { records: [], count: 0 }
      }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const formData = new FormData()
    formData.append('image', new Blob(['fake image bytes'], { type: 'image/png' }), 'receipt.png')
    const response = await fetch(`${url}/api/records/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}` },
      body: formData
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.ocrSessionId, 'session-1')
    assert.equal(json.data.count, 1)
    assert.equal(calls.scanned, 1)
    assert.equal(calls.savedSession, 1)
    assert.equal(calls.confirmed, 0)
  } finally {
    server.close()
  }
})

test('POST /api/records/ocr returns a manual form instead of 500 when provider fails', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    scanReceiptFn: async () => {
      throw new Error('provider token=secret path=D:\\private\\receipt.png')
    }
  }))

  const { server, url } = await listen(app)
  try {
    const formData = new FormData()
    formData.append('image', new Blob(['fake image bytes'], { type: 'image/png' }), 'receipt.png')
    const response = await fetch(`${url}/api/records/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}` },
      body: formData
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'manual_fallback')
    assert.equal(json.data.reason, 'OCR_UNAVAILABLE')
    assert.equal(json.data.form.type, 'expense')
    assert.equal(JSON.stringify(json).includes('secret'), false)
    assert.equal(JSON.stringify(json).includes('private'), false)
  } finally {
    server.close()
  }
})

test('POST /api/records/ocr/confirm keeps the session for idempotent retries', async () => {
  const calls = { readSession: 0, clearSession: 0, confirmed: 0 }
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    ocrSessionService: {
      saveOcrSession: async () => ({ ocrSessionId: 'unused', expiresInSeconds: 1800 }),
      readOcrSession: async input => {
        calls.readSession += 1
        assert.equal(input.userId, 7)
        assert.equal(input.ocrSessionId, 'session-1')
        return { records: [{ amount: 25, category: '餐饮', date: '2026-07-17' }] }
      },
      clearOcrSession: async input => {
        calls.clearSession += 1
        assert.equal(input.ocrSessionId, 'session-1')
      }
    },
    ocrConfirmService: {
      saveConfirmedOcrRecords: async input => {
        calls.confirmed += 1
        assert.equal(input.userId, 7)
        assert.equal(input.uploadId, 'session-1')
        assert.match(input.operationId, /^ocr:/)
        assert.equal(input.confirmedRecords[0].amount, 26)
        return { records: [{ id: 99, amount: 26 }], count: 1 }
      }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const responses = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${url}/api/records/ocr/confirm`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${signToken(7)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ocrSessionId: 'session-1',
          records: [{ amount: 26, category: '餐饮', date: '2026-07-17' }]
        })
      })
      responses.push({ response, json: await response.json() })
    }

    for (const { response, json } of responses) {
      assert.equal(response.status, 200)
      assert.equal(json.success, true)
      assert.equal(json.data.count, 1)
    }
    assert.equal(calls.readSession, 2)
    assert.equal(calls.confirmed, 2)
    assert.equal(calls.clearSession, 0)
  } finally {
    server.close()
  }
})

test('POST /api/records/ocr/confirm returns 404 for expired sessions', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    ocrSessionService: {
      saveOcrSession: async () => ({ ocrSessionId: 'unused', expiresInSeconds: 1800 }),
      readOcrSession: async () => null,
      clearOcrSession: async () => {}
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/ocr/confirm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ocrSessionId: 'expired', records: [{ amount: 26, category: '餐饮', date: '2026-07-17' }] })
    })
    const json = await response.json()

    assert.equal(response.status, 404)
    assert.equal(json.success, false)
    assert.match(json.error, /识别结果已过期/)
  } finally {
    server.close()
  }
})

test('POST /api/records/ocr/confirm does not log confirmation dependency details', async () => {
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args.map(arg => String(arg)).join(' '))
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    ocrSessionService: {
      saveOcrSession: async () => ({}),
      readOcrSession: async () => ({
        userId: 7,
        records: [{ amount: 25, category: '餐饮', date: '2026-07-27' }]
      }),
      clearOcrSession: async () => {}
    },
    ocrConfirmService: {
      saveConfirmedOcrRecords: async () => {
        throw new Error('mysql://finance:secret@private')
      }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/ocr/confirm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ocrSessionId: 'session-1',
        records: [{ amount: 25, category: '餐饮', date: '2026-07-27' }]
      })
    })

    assert.equal(response.status, 400)
    assert.equal(JSON.stringify(logged).includes('secret'), false)
    assert.equal(JSON.stringify(logged).includes('private'), false)
  } finally {
    console.error = originalConsoleError
    server.close()
  }
})
