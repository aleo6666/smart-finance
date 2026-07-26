import {
  normalizeTrustedUserId,
  RuntimeContextValidationError
} from '../runtime.js'

const CANONICAL_INTENT_ORDER = [
  'record',
  'query',
  'stat',
  'analysis',
  'suggest',
  'ocr'
]

function hasRecordIntent(text) {
  return /记(?:一|1)笔|记账|(?:花了|消费了)\s*\d+(?:\.\d+)?(?:元|块)?|(?:收入|支出)\s*\d+(?:\.\d+)?(?:元|块)?|有一笔(?:餐饮|交通|购物|娱乐|医疗|住房)支出/.test(text)
}

function hasQueryIntent(text) {
  return /查询|查(?:(?:一?下)?(?:本月|上月|这个月|上个月)(?:账单|明细|收支)?|(?:一?下)?(?:账单|明细))|看看|明细|哪些账|多少笔/.test(text)
}

function hasStatIntent(text) {
  return /统计|汇总|占比|对比|收支|开销/.test(text)
}

function hasAnalysisIntent(text) {
  return /分析|对比|异常|趋势|状况|原因/.test(text)
}

function hasSuggestIntent(text) {
  return /建议|省钱|规划|怎么省|如何省|控制开支/.test(text)
}

function hasOcrIntent(text) {
  return /小票|发票|OCR|识别.*(?:图片|图像|照片)/i.test(text)
}

function queryIsSubsumedByStat(text) {
  return /查(?:一?下)?(?:本月|上月|这个月|上个月|当月)?收支/.test(text)
}

export function detectCompositeIntent(text) {
  const normalizedText = typeof text === 'string' ? text.trim() : ''
  const detected = new Set()

  if (hasRecordIntent(normalizedText)) detected.add('record')
  if (hasQueryIntent(normalizedText) && !queryIsSubsumedByStat(normalizedText)) {
    detected.add('query')
  }
  if (hasStatIntent(normalizedText)) detected.add('stat')
  if (hasAnalysisIntent(normalizedText)) detected.add('analysis')
  if (hasSuggestIntent(normalizedText)) detected.add('suggest')
  if (hasOcrIntent(normalizedText)) detected.add('ocr')

  if (detected.has('stat') && detected.has('suggest')) {
    detected.add('analysis')
  }

  const result = CANONICAL_INTENT_ORDER.filter(intent => detected.has(intent))
  return result.length > 0 ? result.join('+') : 'chat'
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
    .join(' ')
}

function currentUserText(messages) {
  if (!Array.isArray(messages)) return ''
  const lastUserMessage = messages.findLast(message => {
    const role = message?.role ?? message?._getType?.()
    return role === 'user' || role === 'human'
  })
  return messageText(lastUserMessage)
}

function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectMapOrDefault(value, fallback) {
  return isObjectMap(value) ? value : fallback
}

function objectArrayOrEmpty(value) {
  return Array.isArray(value) && value.every(isObjectMap) ? value : []
}

function requiredRuntimeContext(config) {
  const context = config?.context
  if (!isObjectMap(context)) {
    throw new RuntimeContextValidationError('LangGraph runtime context is required')
  }

  const userId = normalizeTrustedUserId(context.userId)
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : ''
  if (!sessionId || sessionId.length > 128) {
    throw new RuntimeContextValidationError('runtime context sessionId is invalid')
  }

  return { ...context, userId, sessionId }
}

export function createNormalizeRequestNode({ now = Date.now } = {}) {
  return async (state = {}, config = {}) => {
    const context = requiredRuntimeContext(config)
    const requestStartTime = Number(now())
    if (!Number.isInteger(requestStartTime) || requestStartTime < 0) {
      throw new RuntimeContextValidationError('request start time is invalid')
    }

    return {
      userId: context.userId,
      sessionId: context.sessionId,
      sessionMetadata: {
        deviceType: context.deviceType ?? 'unknown',
        timezone: context.timezone ?? 'Asia/Shanghai',
        locale: context.locale ?? 'zh-CN',
        inputMode: context.inputMode === 'voice' ? 'voice' : 'text',
        lastActiveAt: requestStartTime
      },
      userMemory: objectArrayOrEmpty(state.userMemory),
      recentSummary: objectMapOrDefault(state.recentSummary, {}),
      datasetRefs: objectArrayOrEmpty(state.datasetRefs),
      pendingConfirmation: objectMapOrDefault(state.pendingConfirmation, null),
      toolCallCount: Number.isInteger(state.toolCallCount) && state.toolCallCount >= 0
        ? state.toolCallCount
        : 0,
      errors: objectArrayOrEmpty(state.errors),
      response: objectMapOrDefault(state.response, null),
      requestStartTime,
      isAdmin: context.isAdmin === true,
      intentType: detectCompositeIntent(currentUserText(state.messages))
    }
  }
}
