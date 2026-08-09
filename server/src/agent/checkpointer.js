import { MemorySaver } from '@langchain/langgraph'
import { ShallowRedisSaver } from '@langchain/langgraph-checkpoint-redis/shallow'
import config from '../config.js'
import { getRedisUrl } from '../redis.js'

export class CheckpointerSetupError extends Error {
  constructor() {
    super('Redis checkpoint storage is unavailable, falling back to memory')
    this.name = 'CheckpointerSetupError'
    this.code = 'ERR_CHECKPOINTER_SETUP'
    this.statusCode = 503
    this.expose = false
  }
}

async function probeCheckpointer(saver) {
  const threadId = `__probe__:${Date.now()}`
  const config = { configurable: { thread_id: threadId } }
  const checkpoint = {
    v: 1,
    ts: new Date().toISOString(),
    id: `probe-${Date.now()}`,
    channel_values: {}
  }
  try {
    await saver.put(config, checkpoint, { source: 'probe', step: 0 }, {})
    const got = await saver.getTuple(config)
    // 不调用 deleteTuple: ShallowRedisSaver 无此方法, 探针 key 由 defaultTTL 自动清理
    return got?.checkpoint?.id === checkpoint.id
  } catch {
    return false
  }
}

export async function createCheckpointer(
  redisUrl = getRedisUrl(),
  {
    sessionTtlSeconds = config.memory?.sessionTtlSeconds ?? 1800
  } = {}
) {
  try {
    const saver = await ShallowRedisSaver.fromUrl(redisUrl, {
      defaultTTL: Math.ceil(sessionTtlSeconds / 60),
      refreshOnRead: true
    })

    // Index creation may fail on Redis without RediSearch module
    if (typeof saver?.setup === 'function') {
      try {
        await saver.setup()
      } catch {
        console.warn('[Checkpointer] index setup skipped (RediSearch unavailable), using MemorySaver fallback')
        return { saver: new MemorySaver(), redisBacked: false }
      }
    }

    // Real write/read probe — ShallowRedisSaver requires RedisJSON (JSON.SET/GET).
    // A bare redis image reports redisBacked=true but crashes on first put.
    if (!(await probeCheckpointer(saver))) {
      console.warn('[Checkpointer] probe failed (RedisJSON module unavailable?), using MemorySaver fallback')
      return { saver: new MemorySaver(), redisBacked: false }
    }

    return { saver, redisBacked: true }
  } catch {
    console.warn('[Checkpointer] Redis unavailable, using MemorySaver fallback')
    return { saver: new MemorySaver(), redisBacked: false }
  }
}
