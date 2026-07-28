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
    return { saver, redisBacked: true }
  } catch {
    console.warn('[Checkpointer] Redis unavailable, using MemorySaver fallback')
    return { saver: new MemorySaver(), redisBacked: false }
  }
}
