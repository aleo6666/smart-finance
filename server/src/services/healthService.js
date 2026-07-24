const REQUIRED_SERVICES = ['mysql', 'redis', 'qdrant']
const OPTIONAL_SERVICES = ['lmStudioModels', 'lmStudioEmbedding', 'lmStudioChat']
const ALL_SERVICES = [...REQUIRED_SERVICES, ...OPTIONAL_SERVICES]

export async function checkDependencies({ checks }) {
  const services = {}
  let degraded = false

  await Promise.all(ALL_SERVICES.map(async (name) => {
    try {
      const result = await checks[name]()
      services[name] = result
      if (!result.ok && REQUIRED_SERVICES.includes(name)) degraded = true
    } catch (_err) {
      services[name] = { ok: false, reason: 'check failed' }
      if (REQUIRED_SERVICES.includes(name)) degraded = true
    }
  }))

  return {
    status: degraded ? 'degraded' : 'ready',
    services
  }
}

export function createDefaultChecks({ db, redis, qdrantClient, lmStudioClient }) {
  return {
    mysql: async () => {
      try {
        await db.raw('SELECT 1')
        return { ok: true }
      } catch (_err) {
        return { ok: false, reason: '数据库连接失败' }
      }
    },
    redis: async () => {
      try {
        const result = await redis.ping()
        if (result === 'PONG') return { ok: true }
        return { ok: false, reason: 'Redis ping 返回值异常' }
      } catch (_err) {
        return { ok: false, reason: 'Redis 连接失败' }
      }
    },
    qdrant: async () => {
      try {
        await qdrantClient.getCollections()
        return { ok: true }
      } catch (_err) {
        return { ok: false, reason: 'Qdrant 连接失败' }
      }
    },
    lmStudioModels: async () => {
      try {
        const hasBaseUrl = lmStudioClient.listModels && true
        if (!hasBaseUrl) return { ok: true, skipped: true, reason: 'LM Studio 未配置' }
        const models = await lmStudioClient.listModels()
        if (Array.isArray(models) && models.length > 0) {
          return { ok: true }
        }
        return { ok: false, reason: 'LM Studio 模型列表为空' }
      } catch (_err) {
        return { ok: false, reason: 'LM Studio 模型列表获取失败' }
      }
    },
    lmStudioEmbedding: async () => {
      try {
        const embedding = await lmStudioClient.embed('健康检查探针')
        if (Array.isArray(embedding) && embedding.length > 0 && embedding.every(n => typeof n === 'number')) {
          return { ok: true, dimensions: embedding.length }
        }
        return { ok: false, reason: 'LM Studio embedding 返回无效' }
      } catch (_err) {
        return { ok: false, reason: 'LM Studio embedding 失败' }
      }
    },
    lmStudioChat: async () => {
      try {
        const response = await lmStudioClient.chat([{ role: 'user', content: '回复"OK"' }])
        if (response && response.length > 0) {
          return { ok: true }
        }
        return { ok: false, reason: 'LM Studio chat 返回空响应' }
      } catch (_err) {
        return { ok: false, reason: 'LM Studio chat 失败' }
      }
    }
  }
}
