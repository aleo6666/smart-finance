import { emptySummary } from './recentSummary.js'

export function createContextLoader({
  sessionMetadata,
  userMemory,
  recentSummary,
  windowMemory
}) {
  return async ({ userId, sessionId }) => {
    const settled = await Promise.allSettled([
      sessionMetadata.read(userId, sessionId),
      userMemory.listActive(userId),
      recentSummary.read(userId, sessionId),
      windowMemory.read(userId, sessionId)
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
