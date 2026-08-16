import { createHmac } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { authMiddleware } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'

const IAT_URL = 'wss://iat-api.xfyun.cn/v2/iat'
const IAT_HOST = 'iat-api.xfyun.cn'
const IAT_PATH = '/v2/iat'
const PCM_FRAME_BYTES = 2560 // 1280 samples * 2 bytes，16kHz 下约 40ms 一帧
const MAX_DURATION_SECONDS = 60
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const SUPPORTED_WAV_RATES = new Set([8000, 16000])

const logger = createLogger('Speech')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
})

// 讯飞语音听写 v2 鉴权：RFC1123 时间戳 + HMAC-SHA256 base64 签名，拼 authorization 头
export function buildIatAuthorization({ appId, apiKey, apiSecret, date = new Date().toUTCString() }) {
  const signatureOrigin = `host: ${IAT_HOST}\ndate: ${date}\nrequest-line: GET ${IAT_PATH} HTTP/1.1`
  const signature = createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64')
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  return Buffer.from(authorizationOrigin, 'utf8').toString('base64')
}

export function buildIatUrl({ appId, apiKey, apiSecret, date = new Date().toUTCString() }) {
  const authorization = buildIatAuthorization({ appId, apiKey, apiSecret, date })
  return `${IAT_URL}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${IAT_HOST}`
}

export function createIatClient({
  appId = process.env.XFYUN_APPID,
  apiKey = process.env.XFYUN_API_KEY,
  apiSecret = process.env.XFYUN_API_SECRET,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 30000
} = {}) {
  return {
    async transcribe({ audio, encoding = 'raw', sampleRate = 16000 }) {
      if (!appId || !apiKey || !apiSecret) {
        throw Object.assign(
          new Error('讯飞语音听写凭据未配置（XFYUN_APPID/XFYUN_API_KEY/XFYUN_API_SECRET）'),
          { status: 502 }
        )
      }
      if (typeof WebSocketImpl !== 'function') {
        throw Object.assign(new Error('当前 Node 环境不支持 WebSocket'), { status: 502 })
      }

      return new Promise((resolve, reject) => {
        const ws = new WebSocketImpl(buildIatUrl({ appId, apiKey, apiSecret }))
        let settled = false
        let transcript = ''
        const timer = setTimeout(() => fail(new Error('讯飞语音听写超时')), timeoutMs)

        function fail(error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { ws.close() } catch { /* noop */ }
          reject(error)
        }

        function succeed(result) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { ws.close() } catch { /* noop */ }
          resolve(result)
        }

        ws.onopen = () => {
          try {
            sendFrames(ws, { appId, audio, encoding, sampleRate })
          } catch (error) {
            fail(error)
          }
        }

        ws.onmessage = async event => {
          try {
            const raw = typeof event.data === 'string'
              ? event.data
              : Buffer.from(await event.data.arrayBuffer()).toString('utf8')
            const message = JSON.parse(raw)
            if (message.code !== 0) {
              fail(Object.assign(new Error(`讯飞语音听写失败：${message.code} ${message.message}`), { status: 502 }))
              return
            }
            for (const item of message.data?.result?.ws || []) {
              transcript += item.cw?.[0]?.w || ''
            }
            if (message.data?.status === 2) {
              succeed({ text: transcript.trim() })
            }
          } catch (error) {
            fail(error)
          }
        }

        ws.onerror = () => fail(new Error('无法连接讯飞语音听写服务'))
        ws.onclose = () => {
          if (!settled) fail(new Error('讯飞语音听写连接意外关闭'))
        }
      })
    }
  }
}

function sendFrames(ws, { appId, audio, encoding, sampleRate }) {
  if (!audio || audio.length === 0) throw new Error('音频为空')
  const payloads = []
  for (let offset = 0; offset < audio.length; offset += PCM_FRAME_BYTES) {
    payloads.push(audio.subarray(offset, Math.min(offset + PCM_FRAME_BYTES, audio.length)))
  }
  payloads.forEach((payload, index) => {
    const status = payloads.length === 1 ? 2 : index === 0 ? 0 : index === payloads.length - 1 ? 2 : 1
    ws.send(JSON.stringify({
      common: { app_id: appId },
      business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 5000, dwa: 'wpgs' },
      data: { status, format: `audio/L16;rate=${sampleRate}`, encoding, audio: payload.toString('base64') }
    }))
  })
}

export function parseWavHeader(buffer) {
  if (buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  const audioFormat = buffer.readUInt16LE(20)
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bitsPerSample = buffer.readUInt16LE(34)
  let offset = 12
  let dataOffset = -1
  let dataEnd = buffer.length
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      dataOffset = offset + 8
      dataEnd = Math.min(dataOffset + size, buffer.length)
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (dataOffset < 0) return null
  return { audioFormat, channels, sampleRate, bitsPerSample, dataOffset, dataEnd }
}

function detectAudioFormat(buffer, mimetype, originalname) {
  const name = (originalname || '').toLowerCase()
  const mime = (mimetype || '').toLowerCase()
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('hex') === '1a45dfa3') return 'unsupported-webm'
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'unsupported-ogg'
  if (mime.includes('webm') || name.endsWith('.webm')) return 'unsupported-webm'
  if (mime.includes('ogg') || name.endsWith('.ogg')) return 'unsupported-ogg'
  if (mime.includes('wav') || mime.includes('wave') || name.endsWith('.wav')) return 'wav'
  if (mime.includes('pcm') || name.endsWith('.pcm')) return 'pcm'
  return 'unsupported-other'
}

async function transcribeUpload(iatClient, file) {
  const format = detectAudioFormat(file.buffer, file.mimetype, file.originalname)
  if (format.startsWith('unsupported')) {
    const reason = format === 'unsupported-webm' ? 'webm' : format === 'unsupported-ogg' ? 'ogg' : '未知'
    const error = new Error(
      `音频格式不支持（${reason}）：当前仅支持 16kHz/8kHz 16bit 单声道 WAV 或 PCM，请将前端录音改为 WAV/PCM 后上传`
    )
    error.status = 501
    throw error
  }

  if (format === 'wav') {
    const header = parseWavHeader(file.buffer)
    if (!header) {
      const error = new Error('音频格式不支持：无法解析 WAV 文件头')
      error.status = 501
      throw error
    }
    const supported = header.audioFormat === 1 &&
      header.channels === 1 &&
      header.bitsPerSample === 16 &&
      SUPPORTED_WAV_RATES.has(header.sampleRate)
    if (!supported) {
      const error = new Error('音频格式不支持：WAV 需为 PCM 16bit 单声道，采样率 8kHz 或 16kHz')
      error.status = 501
      throw error
    }
    const duration = (header.dataEnd - header.dataOffset) / (header.sampleRate * 2)
    if (duration > MAX_DURATION_SECONDS) {
      const error = new Error('音频超过 60 秒限制')
      error.status = 400
      throw error
    }
    const pcm = file.buffer.subarray(header.dataOffset, header.dataEnd)
    return iatClient.transcribe({ audio: pcm, encoding: 'raw', sampleRate: header.sampleRate })
  }

  const duration = file.buffer.length / (16000 * 2)
  if (duration > MAX_DURATION_SECONDS) {
    const error = new Error('音频超过 60 秒限制')
    error.status = 400
    throw error
  }
  return iatClient.transcribe({ audio: file.buffer, encoding: 'raw', sampleRate: 16000 })
}

export function createSpeechRouter({ iatClient = createIatClient() } = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.post('/transcribe', (req, res) => {
    upload.single('audio')(req, res, async error => {
      if (error) {
        const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
          ? '音频文件过大'
          : '音频上传失败'
        return res.status(400).json({ success: false, error: message })
      }
      try {
        const file = req.file
        if (!file) return res.status(400).json({ success: false, error: '缺少音频文件（字段 audio）' })
        if (!file.size) return res.status(400).json({ success: false, error: '音频文件为空' })
        const result = await transcribeUpload(iatClient, file)
        logger.info('语音转写成功', { userId: req.userId, size: file.size })
        res.json({ success: true, data: { text: result.text } })
      } catch (error) {
        logger.warn('语音转写失败', { userId: req.userId, error: error.message })
        res.status(error.status || 502).json({ success: false, error: error.message })
      }
    })
  })

  return router
}

export default createSpeechRouter()
