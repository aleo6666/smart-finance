import config from '../config.js'

export class LmStudioError extends Error {
  constructor(message, { status = 502, code = 'LM_STUDIO_ERROR' } = {}) {
    super(message)
    this.name = 'LmStudioError'
    this.status = status
    this.code = code
  }
}

export function createLmStudioClient({ settings = config.lmStudio, fetchFn = fetch } = {}) {
  const { baseUrl, embeddingModel, chatModel, embeddingTimeoutMs, chatTimeoutMs, listModelsTimeoutMs } = settings

  function wrapError(err) {
    if (err instanceof LmStudioError) return err
    if (err.name === 'AbortError') {
      return new LmStudioError('LM Studio 请求超时')
    }
    return new LmStudioError('LM Studio 请求失败')
  }

  async function embed(text) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), embeddingTimeoutMs)
    try {
      const res = await fetchFn(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: text }),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new LmStudioError(`LM Studio embeddings 请求失败 (HTTP ${res.status})`, { status: res.status })
      }
      const body = await res.json()
      if (!body.data?.[0]?.embedding || !Array.isArray(body.data[0].embedding) || body.data[0].embedding.length === 0) {
        throw new LmStudioError('LM Studio 返回无效的 embedding 格式')
      }
      return body.data[0].embedding
    } catch (err) {
      throw wrapError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  async function chat(messages) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), chatTimeoutMs)
    try {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: chatModel, messages }),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new LmStudioError(`LM Studio chat 请求失败 (HTTP ${res.status})`, { status: res.status })
      }
      const body = await res.json()
      if (!body.choices?.[0]?.message?.content) {
        throw new LmStudioError('LM Studio 返回格式无效')
      }
      return body.choices[0].message.content
    } catch (err) {
      throw wrapError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  async function listModels() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), listModelsTimeoutMs)
    try {
      const res = await fetchFn(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      })
      if (!res.ok) {
        throw new LmStudioError(`LM Studio models 请求失败 (HTTP ${res.status})`, { status: res.status })
      }
      const body = await res.json()
      if (!body.data || !Array.isArray(body.data)) {
        throw new LmStudioError('LM Studio models 返回格式无效')
      }
      return body.data.map((m) => m.id)
    } catch (err) {
      throw wrapError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  return { embed, chat, listModels }
}

const defaultClient = createLmStudioClient()

export default defaultClient
