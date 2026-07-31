import { createHash } from 'node:crypto'

export function inRollout(userId, percent) {
  if (percent <= 0) return false
  if (percent >= 100) return true
  const digest = createHash('sha256').update(String(userId)).digest()
  return digest.readUInt32BE(0) % 100 < percent
}

const RETRYABLE_RECORD_ERROR_CODES = new Set([
  'INVALID_TOOL_ARGUMENTS',
  'MODEL_UNAVAILABLE',
  'TOOL_CALL_LIMIT'
])

function includesRecordIntent(value) {
  return String(value ?? '').split('+').includes('record')
}

function shouldFallbackToLegacy(result) {
  const response = result?.response
  if (response?.success !== false || !includesRecordIntent(response.intent)) {
    return false
  }
  const errorCodes = Array.isArray(response.errorCodes) ? response.errorCodes : []
  return errorCodes.some(code => RETRYABLE_RECORD_ERROR_CODES.has(code))
}

export function createAgentService({
  config,
  graph,
  createGraph,
  legacy
}) {
  return {
    async handle(state, runtime) {
      const enabled = config?.agent?.enabled === true
      const percent = config?.agent?.rolloutPercent ?? 0

      if (!enabled || !runtime?.userId || !inRollout(runtime.userId, percent)) {
        return legacy(state, runtime)
      }

      try {
        const activeGraph = typeof createGraph === 'function'
          ? createGraph(runtime)
          : graph
        const freshState = {
          ...state,
          datasetRefs: [],
          pendingConfirmation: null,
          toolCallCount: 0,
          errors: [],
          response: null
        }
        const result = await activeGraph.invoke(freshState, {
          configurable: {
            thread_id: `${runtime.userId}:${runtime.sessionId}`
          },
          context: runtime,
          recursionLimit: config?.agent?.recursionLimit ?? 12
        })

        if (shouldFallbackToLegacy(result)) {
          return legacy(state, runtime)
        }

        return {
          success: result?.response?.success !== false,
          data: {
            intent: result?.response?.intent ?? result?.intentType ?? 'chat',
            message: result?.response?.message ?? '',
            errorCodes: result?.response?.errorCodes ?? [],
            source: 'langgraph'
          }
        }
      } catch (error) {
        console.warn('[Agent] graph invoke failed:', error.message)
        const isWriteIntent = includesRecordIntent(state.intentType)
        if (isWriteIntent) {
          return {
            success: true,
            data: {
              intent: state.intentType ?? 'record',
              message: '智能解析暂时不可用，请使用手动记账表单。',
              fallback: { type: 'manual_record_form' },
              source: 'langgraph_fallback'
            }
          }
        }

        // Fall through to legacy for non-write intents
        return legacy(state, runtime)
      }
    }
  }
}
