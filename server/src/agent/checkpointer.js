import { ShallowRedisSaver } from '@langchain/langgraph-checkpoint-redis/shallow'
import config from '../config.js'
import { getRedisUrl } from '../redis.js'

export class CheckpointerSetupError extends Error {
  constructor() {
    super('Redis checkpoint storage is unavailable')
    this.name = 'CheckpointerSetupError'
    this.code = 'ERR_CHECKPOINTER_SETUP'
    this.statusCode = 503
    this.expose = false
  }
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

export async function createCheckpointer(
  redisUrl = getRedisUrl(),
  {
    sessionTtlSeconds = config.memory.sessionTtlSeconds,
    ttlSeconds,
    saverFactory = ShallowRedisSaver
  } = {}
) {
  const lifetimeSeconds = positiveInteger(
    ttlSeconds ?? sessionTtlSeconds,
    'sessionTtlSeconds'
  )
  const ttlConfig = {
    defaultTTL: lifetimeSeconds / 60,
    refreshOnRead: true
  }

  try {
    const saver = typeof saverFactory?.fromUrl === 'function'
      ? await saverFactory.fromUrl(redisUrl, ttlConfig)
      : await saverFactory(redisUrl, ttlConfig)

    // v1.0.10 initializes its indexes inside fromUrl(). This conditional also
    // supports compatible injected factories that expose an explicit setup.
    if (typeof saver?.setup === 'function') await saver.setup()
    return saver
  } catch {
    throw new CheckpointerSetupError()
  }
}
