import Redis from 'ioredis'
import config from './config.js'

let redisClient
const memoryStore = new Map()

export function getRedisClient() {
  if (redisClient) return redisClient

  redisClient = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  })

  redisClient.on('error', error => {
    console.warn('[Redis] error:', error.message)
  })

  return redisClient
}

export async function cacheSet(key, value, ttlSeconds) {
  const payload = JSON.stringify(value)
  try {
    const redis = getRedisClient()
    if (redis.status === 'wait') await redis.connect()
    if (ttlSeconds) await redis.set(key, payload, 'EX', ttlSeconds)
    else await redis.set(key, payload)
  } catch {
    memoryStore.set(key, { value: payload, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null })
  }
}

export async function cacheGet(key) {
  try {
    const redis = getRedisClient()
    if (redis.status === 'wait') await redis.connect()
    const payload = await redis.get(key)
    return payload ? JSON.parse(payload) : null
  } catch {
    const item = memoryStore.get(key)
    if (!item) return null
    if (item.expiresAt && item.expiresAt < Date.now()) {
      memoryStore.delete(key)
      return null
    }
    return JSON.parse(item.value)
  }
}

export async function cacheDelete(key) {
  try {
    const redis = getRedisClient()
    if (redis.status === 'wait') await redis.connect()
    await redis.del(key)
  } catch {
    memoryStore.delete(key)
  }
}

export default getRedisClient
