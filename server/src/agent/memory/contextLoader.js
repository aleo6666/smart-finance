import { emptySummary } from './recentSummary.js'
import {
  normalizeTrustedSessionId,
  normalizeTrustedUserId
} from '../runtime.js'

export function createContextLoader({
  sessionMetadata,
  userMemory,
  recentSummary,
  windowMemory
}) {
  return async ({ userId, sessionId }) => {
    const trustedUserId = normalizeTrustedUserId(userId)
    const trustedSessionId = normalizeTrustedSessionId(sessionId)
    const settled = await Promise.allSettled([
      sessionMetadata.read(trustedUserId, trustedSessionId),
      userMemory.listActive(trustedUserId),
      recentSummary.read(trustedUserId, trustedSessionId),
      windowMemory.read(trustedUserId, trustedSessionId)
    ])
    const fallback = [{}, [], emptySummary(), []]
    const values = settled.map((item, index) =>
      item.status === 'fulfilled' ? item.value : fallback[index]
    )
    return {
      sessionMetadata: values[0],
      userMemory: values[1],
      recentSummary: values[2],
      messages: values[3],
      memoryErrors: settled.flatMap((item, index) =>
        item.status === 'rejected'
          ? [{ layer: index + 1, code: 'MEMORY_LOAD_FAILED' }]
          : []
      )
    }
  }
}
