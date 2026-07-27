import { emptySummary, sanitizeSummary } from '../memory/recentSummary.js'

const SUMMARY_KEYS = Object.freeze([
  'currentTopics',
  'recentReferences',
  'unfinishedTasks',
  'analysisConclusions',
  'plannedActions',
  'temporaryContext'
])

export function createPostTurnMemoryNode({
  windowMemory,
  recentSummary,
  summaryTriggerMessages = 12,
  now = Date.now
}) {
  return async (state) => {
    const { userId, sessionId, messages, response } = state

    // 1. Write last turn to L4 sliding window
    const userMessage = [...(messages ?? [])].reverse().find(
      m => m?.role === 'user'
    )
    const assistantMessage = response?.message
      ? { role: 'assistant', content: String(response.message), ts: now() }
      : null

    const windowEntries = [userMessage, assistantMessage].filter(Boolean)
    let windowMessages = []
    if (windowEntries.length > 0) {
      try {
        windowMessages = await windowMemory.append(userId, sessionId, windowEntries)
      } catch {
        // window failure is not fatal
      }
    }

    // 2. Update L3 summary when message threshold reached
    const messageCount = windowMessages.length
    if (messageCount >= summaryTriggerMessages && typeof recentSummary?.upsert === 'function') {
      try {
        const previous = await recentSummary.read(userId, sessionId)
        const merged = mergeSummary(previous, response, messages, now())
        await recentSummary.upsert({
          userId,
          sessionId,
          summary: merged,
          coveredUntilTurn: messageCount,
          messageCount
        })
      } catch {
        // summary failure is not fatal; emit as non-fatal error
        return {
          errors: [{ code: 'SUMMARY_UPDATE_FAILED', degraded: true }]
        }
      }
    }

    return {}
  }
}

function mergeSummary(previous, response, messages, timestamp) {
  const base = sanitizeSummary(previous)

  // Extract key facts from the response
  if (response?.message) {
    const text = String(response.message)
    if (text) {
      base.currentTopics = dedupeAppend(base.currentTopics, extractTopics(text))
      base.recentReferences = dedupeAppend(base.recentReferences, [text.slice(0, 120)])
    }
  }

  // Track last user intent
  const lastUser = [...(messages ?? [])].reverse().find(m => m?.role === 'user')
  if (lastUser?.content) {
    base.recentReferences = dedupeAppend(
      base.recentReferences,
      [`用户: ${String(lastUser.content).slice(0, 100)}`]
    )
  }

  if (response?.intent) {
    base.temporaryContext = {
      ...(base.temporaryContext || {}),
      lastIntent: String(response.intent).slice(0, 32)
    }
  }

  return base
}

function extractTopics(text) {
  const topics = []
  // Extract key nouns and financial concepts from response
  const patterns = [
    /(?:支出|收入|预算|储蓄|投资|理财|记账|消费)[^，。\n]{0,20}/g,
    /[餐饮|交通|购物|住房|医疗|教育|娱乐]{2,4}(?:支出|消费)/g
  ]
  for (const pattern of patterns) {
    const matches = String(text).match(pattern)
    if (matches) topics.push(...matches)
  }
  return topics.slice(0, 3)
}

function dedupeAppend(existing, newItems) {
  const seen = new Set(existing)
  for (const item of newItems) {
    if (!seen.has(item)) {
      seen.add(item)
      existing.push(item)
    }
  }
  return existing.slice(-8)
}
