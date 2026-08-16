import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createSpeechRouter, createIatClient } from '../src/routes/speech.js'
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

function createWavBuffer({ sampleRate = 16000, durationSeconds = 0.2, channels = 1, bitsPerSample = 16 } = {}) {
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = Math.floor(sampleRate * blockAlign * durationSeconds)
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.sentFrames = []
    this.closeCode = null
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.onopen) this.onopen({ type: 'open' })
    })
  }

  send(payload) {
    const frame = JSON.parse(payload)
    this.sentFrames.push(frame)
    queueMicrotask(() => this.respond(frame))
  }

  close() {
    this.closeCode = 1000
    if (this.onclose) this.onclose({ code: 1000 })
  }

  emit(payload) {
    this.onmessage({ data: JSON.stringify(payload) })
  }
}

class SuccessWebSocket extends FakeWebSocket {
  respond(frame) {
    const isLast = frame.data.status === 2
    const word = isLast ? '世界' : frame.data.status === 0 ? '你好' : ''
    this.emit({
      code: 0,
      message: 'success',
      sid: 'test-sid',
      data: {
        status: frame.data.status,
        result: {
          sn: this.sentFrames.length,
          ls: isLast,
          bg: 0,
          ed: 0,
          ws: [{ bg: 0, cw: [{ w: word }] }]
        }
      }
    })
  }
}

class FailureWebSocket extends FakeWebSocket {
  respond() {
    this.emit({ code: 10105, message: 'invalid appid', sid: 'test-sid', data: {} })
  }
}

function createApp(iatClient) {
  const app = express()
  app.use(express.json())
  app.use('/api/speech', createSpeechRouter({ iatClient }))
  return app
}

function createTestIatClient(WebSocketImpl) {
  return createIatClient({
    appId: 'test-app-id',
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    WebSocketImpl
  })
}

async function postAudio(url, { token, blob, filename, field = 'audio' } = {}) {
  const formData = new FormData()
  formData.append(field, blob, filename)
  return fetch(`${url}/api/speech/transcribe`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData
  })
}

test('POST /api/speech/transcribe requires authentication', async () => {
  FakeWebSocket.instances = []
  const app = createApp(createTestIatClient(SuccessWebSocket))
  const { server, url } = await listen(app)
  try {
    const blob = new Blob([createWavBuffer()], { type: 'audio/wav' })
    const response = await postAudio(url, { blob, filename: 'speech.wav' })
    assert.equal(response.status, 401)
    assert.equal(FakeWebSocket.instances.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/speech/transcribe transcribes a wav file and signs the iat url', async () => {
  FakeWebSocket.instances = []
  const app = createApp(createTestIatClient(SuccessWebSocket))
  const { server, url } = await listen(app)
  try {
    const blob = new Blob([createWavBuffer({ durationSeconds: 0.2 })], { type: 'audio/wav' })
    const response = await postAudio(url, { token: signToken(7), blob, filename: 'speech.wav' })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.text, '你好世界')

    const ws = FakeWebSocket.instances[0]
    assert.ok(ws)
    const params = new URL(ws.url).searchParams
    assert.equal(params.get('host'), 'iat-api.xfyun.cn')
    assert.ok(params.get('date'))
    const decodedAuthorization = Buffer.from(params.get('authorization'), 'base64').toString('utf8')
    assert.match(decodedAuthorization, /api_key="test-api-key"/)
    assert.match(decodedAuthorization, /algorithm="hmac-sha256"/)
    assert.match(decodedAuthorization, /headers="host date request-line"/)
    assert.match(decodedAuthorization, /signature="[^"]+"/)

    assert.deepEqual(ws.sentFrames.map(frame => frame.common.app_id), ['test-app-id', 'test-app-id', 'test-app-id'])
    assert.deepEqual(ws.sentFrames.map(frame => frame.data.status), [0, 1, 2])
    assert.deepEqual(ws.sentFrames.map(frame => frame.data.format), ['audio/L16;rate=16000', 'audio/L16;rate=16000', 'audio/L16;rate=16000'])
    assert.deepEqual(ws.sentFrames.map(frame => frame.data.encoding), ['raw', 'raw', 'raw'])
    assert.equal(ws.sentFrames.reduce((sum, frame) => sum + Buffer.from(frame.data.audio, 'base64').length, 0), 6400)
  } finally {
    server.close()
  }
})

test('POST /api/speech/transcribe returns 400 when audio field is missing', async () => {
  FakeWebSocket.instances = []
  const app = createApp(createTestIatClient(SuccessWebSocket))
  const { server, url } = await listen(app)
  try {
    const formData = new FormData()
    const response = await fetch(`${url}/api/speech/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(7)}` },
      body: formData
    })
    const json = await response.json()
    assert.equal(response.status, 400)
    assert.equal(json.success, false)
    assert.equal(FakeWebSocket.instances.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/speech/transcribe returns 400 for an empty audio file', async () => {
  FakeWebSocket.instances = []
  const app = createApp(createTestIatClient(SuccessWebSocket))
  const { server, url } = await listen(app)
  try {
    const blob = new Blob([], { type: 'audio/wav' })
    const response = await postAudio(url, { token: signToken(7), blob, filename: 'empty.wav' })
    const json = await response.json()
    assert.equal(response.status, 400)
    assert.equal(json.success, false)
    assert.equal(FakeWebSocket.instances.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/speech/transcribe returns 501 for webm and ogg uploads', async () => {
  FakeWebSocket.instances = []
  const app = createApp(createTestIatClient(SuccessWebSocket))
  const { server, url } = await listen(app)
  try {
    const webmBytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake webm')])
    const webmResponse = await postAudio(url, {
      token: signToken(7),
      blob: new Blob([webmBytes], { type: 'audio/webm' }),
      filename: 'recording.webm'
    })
    const webmJson = await webmResponse.json()
    assert.equal(webmResponse.status, 501)
    assert.match(webmJson.error, /音频格式不支持（webm）/)
    assert.match(webmJson.error, /WAV\/PCM/)

    const oggResponse = await postAudio(url, {
      token: signToken(7),
      blob: new Blob([Buffer.concat([Buffer.from('OggS'), Buffer.from('fake ogg')])], { type: 'audio/ogg' }),
      filename: 'recording.ogg'
    })
    const oggJson = await oggResponse.json()
    assert.equal(oggResponse.status, 501)
    assert.match(oggJson.error, /音频格式不支持（ogg）/)
    assert.equal(FakeWebSocket.instances.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/speech/transcribe returns 502 when xfyun reports an error', async () => {
  FakeWebSocket.instances = []
  const app = createApp(createTestIatClient(FailureWebSocket))
  const { server, url } = await listen(app)
  try {
    const blob = new Blob([createWavBuffer()], { type: 'audio/wav' })
    const response = await postAudio(url, { token: signToken(7), blob, filename: 'speech.wav' })
    const json = await response.json()
    assert.equal(response.status, 502)
    assert.equal(json.success, false)
    assert.match(json.error, /讯飞语音听写失败：10105 invalid appid/)
  } finally {
    server.close()
  }
})
