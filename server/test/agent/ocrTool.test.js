import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createOcrTool,
  createPaddleOcrClient,
  manualOcrFallback
} from '../../src/agent/tools/ocrTool.js'

function validRecord(overrides = {}) {
  return {
    type: 'expense',
    amount: 25,
    category: '餐饮',
    description: '午餐',
    date: '2026-07-27',
    merchant: '餐厅',
    ...overrides
  }
}

function createTool(overrides = {}) {
  return createOcrTool({
    runtime: { userId: 7 },
    enabled: true,
    timeoutMs: 50,
    resolveUpload: async ({ uploadId, userId }) => ({
      uploadId,
      userId,
      path: 'D:\\private\\receipt.png'
    }),
    client: {
      parse: async () => ({ secretRawText: '合计 25.00', blocks: [] })
    },
    normalize: () => validRecord(),
    ...overrides
  })
}

test('OCR returns a bounded preview and never records automatically', async () => {
  let recorded = false
  const tool = createTool({
    recordTransaction: async () => {
      recorded = true
    },
    normalize: () => ({
      ...validRecord(),
      amount_cny: 25,
      rawText: 'private OCR text',
      filePath: 'D:\\private\\receipt.png',
      accessToken: 'secret'
    })
  })

  const result = await tool.invoke({ uploadId: 'up-1' })

  assert.deepEqual(result, {
    status: 'needs_confirmation',
    preview: validRecord({ currency: 'CNY' }),
    source: { uploadId: 'up-1', provider: 'paddleocr' }
  })
  assert.equal(recorded, false)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('OCR tool accepts only a safe server upload id', async () => {
  const tool = createTool()

  for (const input of [
    { uploadId: '' },
    { uploadId: '../receipt.png' },
    { uploadId: 'a'.repeat(129) },
    { uploadId: 'up-1', filePath: 'D:\\private\\receipt.png' },
    { uploadId: 'up-1', url: 'https://internal/receipt.png' }
  ]) {
    await assert.rejects(tool.invoke(input))
  }
})

test('OCR resolves the upload with trusted user ownership before calling provider', async () => {
  const calls = []
  const tool = createTool({
    resolveUpload: async input => {
      calls.push(['resolve', input])
      return { uploadId: input.uploadId, userId: 7, bytes: Buffer.from('image') }
    },
    client: {
      parse: async input => {
        calls.push(['parse', input])
        return {}
      }
    }
  })

  await tool.invoke({ uploadId: 'up_abc-1' })

  assert.deepEqual(calls[0], ['resolve', { uploadId: 'up_abc-1', userId: 7 }])
  assert.deepEqual(calls[1], ['parse', { bytes: Buffer.from('image') }])
})

test('OCR rejects missing and cross-user uploads without leaking paths or provider data', async () => {
  for (const [resolveUpload, expectedCode] of [
    [async () => null, 'UPLOAD_NOT_FOUND'],
    [async () => ({ userId: 8, path: 'D:\\other-user\\secret.png' }), 'FORBIDDEN'],
    [async () => { throw new Error('s3://secret-bucket/private.png') }, 'UPLOAD_NOT_FOUND']
  ]) {
    const tool = createTool({ resolveUpload })
    await assert.rejects(
      tool.invoke({ uploadId: 'up-1' }),
      error =>
        error.code === expectedCode &&
        !error.message.includes('secret') &&
        !error.message.includes('other-user')
    )
  }
})

test('disabled, timed out, and failed providers return the same safe manual form', async () => {
  const cases = [
    createTool({ enabled: false }),
    createTool({
      timeoutMs: 5,
      client: { parse: async () => new Promise(() => {}) }
    }),
    createTool({
      client: {
        parse: async () => {
          throw new Error('token=provider-secret raw=private receipt')
        }
      }
    }),
    createTool({
      normalize: () => ({ amount: 0, category: '', date: 'not-a-date' })
    })
  ]

  const results = await Promise.all(cases.map(tool => tool.invoke({ uploadId: 'up-1' })))

  assert.deepEqual(results[0], manualOcrFallback('OCR_DISABLED'))
  for (const result of results.slice(1)) {
    assert.deepEqual(result, manualOcrFallback('OCR_UNAVAILABLE'))
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(JSON.stringify(result).includes('private'), false)
  }
})

test('OCR timeout aborts the in-flight provider request', async () => {
  let aborted = false
  const tool = createTool({
    timeoutMs: 5,
    client: {
      parse: async (_input, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(signal.reason)
        }, { once: true })
      })
    }
  })

  const result = await tool.invoke({ uploadId: 'up-1' })

  assert.deepEqual(result, manualOcrFallback('OCR_UNAVAILABLE'))
  assert.equal(aborted, true)
})

test('PaddleOCR adapter injects access token only from config and passes an internal path', async () => {
  const constructorInputs = []
  const ocrInputs = []
  class FakeClient {
    constructor(input) {
      constructorInputs.push(input)
    }

    async ocr(input, options) {
      ocrInputs.push([input, options])
      return { pages: [] }
    }
  }
  const client = createPaddleOcrClient({
    config: {
      paddleOcr: {
        accessToken: 'config-only-token',
        requestTimeoutMs: 1234,
        pollTimeoutMs: 5678
      }
    },
    ClientClass: FakeClient
  })

  const controller = new AbortController()
  await client.parse(
    { filePath: 'D:\\trusted\\receipt.png' },
    { signal: controller.signal }
  )

  assert.deepEqual(constructorInputs, [{
    token: 'config-only-token',
    requestTimeout: 1234,
    pollTimeout: 5678
  }])
  assert.equal(ocrInputs[0][0].filePath, 'D:\\trusted\\receipt.png')
  assert.equal(ocrInputs[0][1].signal, controller.signal)
  assert.equal(JSON.stringify(ocrInputs[0]).includes('config-only-token'), false)
})
