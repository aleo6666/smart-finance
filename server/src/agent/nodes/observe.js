export function createObserveNode({
  recordAgentEvent
}) {
  return async (state, graphConfig) => {
    const runtime = graphConfig?.context ?? {}

    const event = buildObserveEvent(state, runtime)

    try {
      if (typeof recordAgentEvent === 'function') {
        await recordAgentEvent(event)
      }
    } catch {
      // observe failure must never block the response
    }

    return {}
  }
}

export function buildObserveEvent(state, runtime) {
  const requestStartTime = Number(state.requestStartTime)
  const latencyMs = Number.isFinite(requestStartTime)
    ? Math.max(0, Date.now() - requestStartTime)
    : 0

  const errorCodes = (state.errors ?? []).map(item => item?.code).filter(Boolean)

  // Extract tool names from state (sanitized - no args)
  const toolNames = extractToolNames(state.messages ?? [])

  return {
    userId: state.userId,
    sessionId: state.sessionId,
    requestId: runtime.requestId ?? '',
    initialIntentType: state.intentType,
    finalIntentType: state.intentType,
    toolNames,
    toolCallCount: Number(state.toolCallCount ?? 0),
    latencyMs,
    errorCodes,
    degraded: (state.errors ?? []).some(item => item?.degraded === true),
    success: errorCodes.length === 0
  }
}

function extractToolNames(messages) {
  const names = new Set()
  for (const message of messages ?? []) {
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.name) names.add(String(call.name))
      }
    }
  }
  return [...names]
}
