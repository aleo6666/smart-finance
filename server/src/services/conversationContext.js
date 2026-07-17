import { cacheDelete, cacheGet, cacheSet } from '../redis.js'

const DEFAULT_TTL_SECONDS = 1800
const DEFAULT_MAX_MESSAGES = 8
const SUMMARY_PREFIX = '[上文摘要]'

function contextKey(identity) {
  return `ctx:${identity}`
}

function normalizeMessage(message) {
  return {
    role: ['user', 'assistant', 'system'].includes(message?.role) ? message.role : 'user',
    content: String(message?.content || '').slice(0, 1000),
    ts: message?.ts || Date.now()
  }
}

function uniqueKeywordsFrom(text) {
  const keywords = ['本月', '上月', '餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '预算', '趋势']
  return keywords.filter(keyword => text.includes(keyword))
}

export function buildContextSummary(messages) {
  const text = messages.map(item => item.content).join('；')
  const keywords = uniqueKeywordsFrom(text)
  const clipped = text.replace(/\s+/g, ' ').slice(0, 100)
  const keywordText = keywords.length ? `关键词：${keywords.join('、')}。` : ''
  return `${keywordText}${clipped}`.slice(0, 160)
}

export async function getConversationContext(identity, { cache = { get: cacheGet } } = {}) {
  if (!identity) return []
  try {
    const value = await cache.get(contextKey(identity))
    return Array.isArray(value) ? value : []
  } catch (error) {
    console.warn('[ConversationContext] read skipped:', error.message)
    return []
  }
}

export async function appendConversationMessage(identity, message, {
  cache = { get: cacheGet, set: cacheSet },
  ttlSeconds = DEFAULT_TTL_SECONDS,
  maxMessages = DEFAULT_MAX_MESSAGES
} = {}) {
  if (!identity || !message?.content) return []
  try {
    const current = await getConversationContext(identity, { cache })
    let next = [...current, normalizeMessage(message)]

    if (next.length > maxMessages) {
      const oldMessages = next.slice(0, next.length - (maxMessages - 1))
      const recent = next.slice(-(maxMessages - 1))
      next = [
        { role: 'system', content: `${SUMMARY_PREFIX} ${buildContextSummary(oldMessages)}`, ts: Date.now() },
        ...recent
      ]
    }

    await cache.set(contextKey(identity), next, ttlSeconds)
    return next
  } catch (error) {
    console.warn('[ConversationContext] write skipped:', error.message)
    return []
  }
}

export async function clearConversationContext(identity, { cache = { del: cacheDelete } } = {}) {
  if (!identity) return
  try {
    await cache.del(contextKey(identity))
  } catch (error) {
    console.warn('[ConversationContext] clear skipped:', error.message)
  }
}
