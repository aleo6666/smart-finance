import { AsyncLocalStorage } from 'node:async_hooks'
import {
  AIMessage,
  RemoveMessage,
  ToolMessage,
  coerceMessageLikeToMessage,
  isAIMessage
} from '@langchain/core/messages'
import {
  END,
  REMOVE_ALL_MESSAGES,
  START,
  StateGraph
} from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { tool } from 'langchain'
import defaultConfig from '../config.js'
import { AgentState } from './state.js'
import { composeModelMessages } from './prompts.js'
import { createNormalizeRequestNode } from './nodes/normalizeRequest.js'
import { createComposePromptNode } from './nodes/composePrompt.js'
import { createValidateToolCallNode } from './nodes/validateToolCall.js'
import {
  createPendingConfirmationNode,
  createRiskNode,
  hasWriteToolCall,
  isValidPendingConfirmation
} from './nodes/riskAndConfirmation.js'
import { hashOperation } from './stores/operationStore.js'

const DATASET_SCOPE_FIELDS = new Set([
  'month',
  'startDate',
  'endDate',
  'category',
  'type',
  'queryKind'
])

const POST_WRITE_ANALYSIS_INTENTS = new Set([
  'query',
  'stat',
  'analysis',
  'suggest'
])

const DOMAIN_TOOL_NAMES = new Set([
  'query_transactions',
  'calculate_finance_metrics',
  'check_budget'
])

const TEXT_TOOL_ALIASES = {
  get_bills: 'query_transactions',
  add_bill: 'record_transaction',
  get_budgets: 'check_budget',
  calculate_budget: 'check_budget'
}

/**
 * 简易 JSON 修复工具 - 处理模型输出的常见 JSON 格式问题
 * 处理场景：
 * 1. 单引号 → 双引号
 * 2. 缺少引号的键名
 * 3. 多余的尾随逗号
 * 4. 单行注释 //
 * 5. 未转义的换行符
 */
function jsonRepair(input) {
  if (typeof input !== 'string') return input
  let str = input.trim()
  if (!str) return str

  try {
    // 先尝试直接解析
    JSON.parse(str)
    return str
  } catch { /* 继续修复 */ }

  // 1. 移除单行注释（不在字符串内的 // 注释）
  str = str.replace(/\/\/[^\n\r]*/g, '')

  // 2. 移除多行注释（不在字符串内的 /* */ 注释）
  str = str.replace(/\/\*[\s\S]*?\*\//g, '')

  // 3. 处理单引号 → 双引号（简单处理，不处理嵌套情况）
  // 先把双引号替换成占位符
  const placeholders = []
  let placeholderIndex = 0
  str = str.replace(/"([^"\\]|\\.)*"/g, match => {
    placeholders.push(match)
    return `__DOUBLE_QUOTE_${placeholderIndex++}__`
  })
  // 把单引号替换成双引号
  str = str.replace(/'/g, '"')
  // 还原双引号
  placeholders.forEach((p, i) => {
    str = str.replace(`__DOUBLE_QUOTE_${i}__`, p)
  })

  // 4. 给没有引号的键名加引号（简单处理：{ key: value } → { "key": value }）
  str = str.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')

  // 5. 移除尾随逗号（在 } 或 ] 之前的逗号）
  str = str.replace(/,(\s*[}\]])/g, '$1')

  // 6. 处理未转义的换行符（在字符串内的换行）
  // 这个比较复杂，简单处理：把字符串内的换行替换成 \n
  // 先尝试直接解析，如果还不行就跳过这个步骤

  try {
    JSON.parse(str)
    return str
  } catch { /* 继续尝试其他修复 */ }

  // 7. 处理数字开头的 0（如 0123 → 123）- 简单跳过，不处理

  // 如果修复失败，返回原始字符串
  return input
}

function parseTextToolCalls(content, knownNames) {
  if (typeof content !== 'string') return { text: content, toolCalls: [] }

  const blocks = []
  const fenceRe = /```json\s*([\s\S]*?)\s*```/g
  let match
  while ((match = fenceRe.exec(content)) !== null) {
    blocks.push({ raw: match[0], json: match[1] })
  }

  if (blocks.length === 0) {
    // 1. 先尝试把整个文本当作 JSON 解析（支持嵌套的 OpenAI 格式：name + arguments）
    const trimmed = content.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && (typeof parsed.name === 'string' || typeof parsed.tool === 'string')) {
          blocks.push({ raw: content, json: trimmed })
        }
      } catch {
        // 解析失败，继续尝试其他方式
        try {
          const repaired = jsonRepair(trimmed)
          const parsed = JSON.parse(repaired)
          if (parsed && (typeof parsed.name === 'string' || typeof parsed.tool === 'string')) {
            blocks.push({ raw: content, json: repaired })
          }
        } catch { /* 修复失败，继续 */ }
      }
    }

    // 2. 用计数器方式提取完整的嵌套 JSON 对象（支持 arguments 等嵌套结构）
    if (blocks.length === 0) {
      function extractNestedJson(str) {
        const results = []
        let depth = 0
        let start = -1
        let inString = false
        let escape = false

        for (let i = 0; i < str.length; i++) {
          const char = str[i]
          if (escape) { escape = false; continue }
          if (char === '\\') { escape = true; continue }
          if (char === '"') { inString = !inString; continue }
          if (inString) continue
          if (char === '{') {
            if (depth === 0) start = i
            depth++
          } else if (char === '}') {
            depth--
            if (depth === 0 && start !== -1) {
              results.push(str.slice(start, i + 1))
              start = -1
            }
          }
        }
        return results
      }

      const jsonCandidates = extractNestedJson(content)
      for (const jsonStr of jsonCandidates) {
        try {
          const parsed = JSON.parse(jsonStr)
          if (parsed && (typeof parsed.name === 'string' || typeof parsed.tool === 'string')) {
            blocks.push({ raw: jsonStr, json: jsonStr })
            break // 找到第一个就够了
          }
        } catch {
          // 解析失败，跳过
        }
      }
    }

    // 3. 匹配包含 "tool" 或 "name" 字段的简单 JSON 对象
    if (blocks.length === 0) {
      const bareRe = /\{[^}]*"(tool|name)"\s*:\s*"[^"]*"[^}]*\}/g
      while ((match = bareRe.exec(content)) !== null) {
        blocks.push({ raw: match[0], json: match[0] })
      }
    }

    // 4. 匹配包含特定参数的简单 JSON 对象（兜底）
    if (blocks.length === 0) {
      const paramRe = /\{[^}]*"(start_?date|end_?date|month|amount|category|type|query)"[^}]*\}/gi
      while ((match = paramRe.exec(content)) !== null) {
        blocks.push({ raw: match[0], json: match[0] })
      }
    }
  }

  const ARGS_KEY_MAP = {
    start_date: 'startDate',
    end_date: 'endDate',
    startDate: 'startDate',
    endDate: 'endDate',
    query_kind: 'queryKind',
    queryKind: 'queryKind',
    knowledge_space_id: 'knowledgeSpaceId',
    knowledgeSpaceId: 'knowledgeSpaceId'
  }

  function hasQueryParams(obj) {
  if (!obj || typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  return keys.some(k => /^(start_?date|end_?date|month|amount|category|type|query)$/i.test(k))
}

function guessToolByParams(obj) {
  if (!obj || typeof obj !== 'object') return null
  const keys = Object.keys(obj)
  if (keys.some(k => /^(start_?date|end_?date|month|category|type|query_kind|queryKind)$/i.test(k))) return 'query_transactions'
  if (keys.some(k => /^(amount)$/i.test(k))) return 'record_transaction'
  return null
}

function normalizeArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
    const normalized = {}
    for (const [key, value] of Object.entries(args)) {
      const mapped = ARGS_KEY_MAP[key] || key
      normalized[mapped] = value
    }
    return normalized
  }

  const toolCalls = []
  let cleanContent = content
  for (const block of blocks) {
    let parsed = null
    try {
      parsed = JSON.parse(block.json.trim())
    } catch {
      // 尝试修复 JSON
      try {
        const repaired = jsonRepair(block.json.trim())
        parsed = JSON.parse(repaired)
      } catch { /* 修复失败，跳过 */ }
    }

    if (parsed && (typeof parsed.tool === 'string' || typeof parsed.name === 'string' || hasQueryParams(parsed))) {
      const aliasName = parsed.tool || parsed.name || guessToolByParams(parsed)
      const resolvedName = TEXT_TOOL_ALIASES[aliasName] || aliasName
      if (resolvedName && knownNames.has(resolvedName)) {
        toolCalls.push({
          id: `text_${Math.random().toString(36).slice(2, 10)}`,
          name: resolvedName,
          args: normalizeArgs(parsed.arguments || parsed.params || parsed),
          type: 'tool_call'
        })
        cleanContent = cleanContent.replace(block.raw, '')
      }
    }
  }

  return { text: cleanContent.trim(), toolCalls }
}

function safeError(code, source) {
  return { code, source, fatal: true }
}

function getErrorMessage(code) {
  const messages = {
    'INVALID_TOOL_ARGUMENTS': '工具参数格式不正确，请检查参数名称和类型是否正确，使用驼峰命名（如 startDate）',
    'DATASET_SCOPE_REJECTED': '数据集引用无效，请先调用 query_transactions 获取数据集引用',
    'UNKNOWN_TOOL': '未知工具，请使用已有的工具',
    'TRUSTED_ARGUMENT_REJECTED': '参数包含受信任字段，已拒绝',
    'TOOL_CALL_LIMIT': '工具调用次数超过限制'
  }
  return messages[code] || '工具调用失败，请重试'
}

function normalizeNodeResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
}

function toolCallsFromLastMessage(state) {
  const last = state?.messages?.at(-1)
  return isAIMessage(last) && Array.isArray(last.tool_calls)
    ? last.tool_calls
    : []
}

function isAdminSqlTool(candidate) {
  return candidate?.metadata?.adminSql === true
}

function isDomainTool(candidate) {
  return candidate?.metadata?.domainTool === true ||
    DOMAIN_TOOL_NAMES.has(candidate?.name)
}

function toolResult(message) {
  if (
    message?._getType?.() !== 'tool' ||
    typeof message.content !== 'string'
  ) {
    return null
  }
  try {
    const result = JSON.parse(message.content)
    return result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : null
  } catch {
    return null
  }
}

function analysisIntent(value) {
  return String(value || '').split('+').includes('analysis')
}

function createLoadMemoryNode(loadMemoryContext) {
  return async state => {
    let loaded
    try {
      loaded = await loadMemoryContext({
        userId: state.userId,
        sessionId: state.sessionId
      })
    } catch {
      return {
        errors: [{
          code: 'MEMORY_LOAD_FAILED',
          source: 'load_memory_context',
          fatal: false
        }]
      }
    }

    const currentMessages = Array.isArray(state.messages) ? state.messages : []
    const currentSignatures = new Set(currentMessages.map(message =>
      `${message?._getType?.() ?? message?.role}:${String(message?.content ?? '')}`
    ))
    const windowMessages = Array.isArray(loaded?.messages)
      ? loaded.messages.flatMap(message => {
        try {
          const normalized = coerceMessageLikeToMessage(message)
          const signature = `${normalized._getType()}:${String(normalized.content ?? '')}`
          return currentSignatures.has(signature) ? [] : [normalized]
        } catch {
          return []
        }
      })
      : []
    return {
      sessionMetadata: {
        ...(loaded?.sessionMetadata ?? {}),
        ...(state.sessionMetadata ?? {})
      },
      userMemory: Array.isArray(loaded?.userMemory) ? loaded.userMemory : [],
      recentSummary: loaded?.recentSummary &&
        typeof loaded.recentSummary === 'object' &&
        !Array.isArray(loaded.recentSummary)
        ? loaded.recentSummary
        : {},
      messages: [
        new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
        ...windowMessages,
        ...currentMessages
      ],
      errors: Array.isArray(loaded?.memoryErrors)
        ? loaded.memoryErrors.map(() => ({
          code: 'MEMORY_LOAD_FAILED',
          source: 'load_memory_context',
          fatal: false
        }))
        : []
    }
  }
}

function safeExecutableTools(tools) {
  return tools.map(original => tool(async (input, runtime) => {
    try {
      return await original.invoke(input, runtime)
    } catch {
      return {
        status: 'error',
        error: { code: 'TOOL_EXECUTION_FAILED' }
      }
    }
  }, {
    name: original.name,
    description: original.description,
    schema: original.schema
  }))
}

function metadataFromToolMessages(messages) {
  if (!Array.isArray(messages)) return []
  const result = []
  for (const message of messages) {
    if (message?._getType?.() !== 'tool' || typeof message.content !== 'string') continue
    let parsed
    try {
      parsed = JSON.parse(message.content)
    } catch {
      continue
    }
    if (
      !parsed ||
      typeof parsed.datasetRef !== 'string' ||
      !/^ds_[A-Za-z0-9-]{1,128}$/.test(parsed.datasetRef)
    ) continue
    const scope = {}
    if (parsed.scope && typeof parsed.scope === 'object' && !Array.isArray(parsed.scope)) {
      for (const [key, value] of Object.entries(parsed.scope)) {
        if (
          DATASET_SCOPE_FIELDS.has(key) &&
          typeof value === 'string' &&
          value.length <= 64
        ) {
          scope[key] = value
        }
      }
    }
    result.push({
      datasetRef: parsed.datasetRef,
      count: Number.isInteger(parsed.count) && parsed.count >= 0 ? parsed.count : 0,
      scope
    })
  }
  return result
}

function mergeDatasetRefs(current, added) {
  const byRef = new Map()
  for (const item of [...(current ?? []), ...added]) {
    if (item && typeof item.datasetRef === 'string') {
      byRef.set(item.datasetRef, item)
    }
  }
  return [...byRef.values()]
}

function responseText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : ''
}

function toolMessage({
  id,
  name,
  value
}) {
  return new ToolMessage({
    content: JSON.stringify(value ?? null),
    tool_call_id: id,
    name
  })
}

function resolvedToolMessages(calls, executedMessages) {
  const executedById = new Map(executedMessages.map(
    message => [message.tool_call_id, message]
  ))
  return calls.map(call => executedById.get(call.id) ?? toolMessage({
    id: call.id,
    name: call.name,
    value: {
      status: 'error',
      error: { code: 'TOOL_CALL_RETRY_REQUIRED' }
    }
  }))
}

function failedToolMessages(calls, code) {
  return calls.map(call => toolMessage({
    id: call.id,
    name: call.name,
    value: {
      status: 'error',
      error: { code }
    }
  }))
}

const SUCCESS_TOOL_STATUSES = new Set([
  'active',
  'completed',
  'deleted',
  'ok',
  'pending',
  'success',
  'updated'
])

function successfulToolResult(messages, toolCallId) {
  const message = messages.find(item => item.tool_call_id === toolCallId)
  if (!message || typeof message.content !== 'string') {
    return { success: false }
  }
  let result
  try {
    result = JSON.parse(message.content)
  } catch {
    return { success: false }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: false }
  }
  const explicitSuccess =
    result.success === true ||
    SUCCESS_TOOL_STATUSES.has(result.status) ||
    Array.isArray(result.recordIds)
  return explicitSuccess &&
    result.success !== false &&
    result.status !== 'error' &&
    !result.error
    ? { success: true, result }
    : { success: false }
}

function writeSuccessMessage(toolName) {
  if (toolName === 'record_transaction') return '记账成功。'
  if (toolName === 'delete_user_memory') return '删除成功。'
  return '更新成功。'
}

function continuesAfterWrite(state) {
  return String(state.intentType).split('+').some(
    intent => POST_WRITE_ANALYSIS_INTENTS.has(intent)
  )
}

function successfulWriteMessages(state, pending, sourceCalls, toolMessages) {
  const resolved = resolvedToolMessages(sourceCalls, toolMessages)
  return continuesAfterWrite(state)
    ? resolved
    : [...resolved, new AIMessage(writeSuccessMessage(pending.toolName))]
}

function createFinalizeNode() {
  return async state => {
    const fatalErrors = (state.errors ?? []).filter(item => item?.fatal === true)
    const lastAi = [...(state.messages ?? [])].reverse().find(isAIMessage)
    const aiText = responseText(lastAi)
    const message = fatalErrors.length > 0
      ? '请求无法安全执行，请调整后重试。'
      : aiText || '暂时无法生成回复，请稍后重试。'
    return {
      response: {
        success: fatalErrors.length === 0,
        intent: state.intentType,
        message,
        errorCodes: fatalErrors.map(item => item.code)
      }
    }
  }
}

function terminateConfirmation(state) {
  const expired = (state.errors ?? []).some(
    item => item?.code === 'CONFIRMATION_EXPIRED'
  )
  const code = expired
    ? 'CONFIRMATION_EXPIRED'
    : 'CONFIRMATION_REJECTED'
  const message = expired
    ? '确认已过期，未执行。'
    : '已取消，未执行。'
  return {
    messages: failedToolMessages(toolCallsFromLastMessage(state), code),
    response: {
      success: false,
      intent: state.intentType,
      message,
      errorCodes: [code]
    }
  }
}

export function createAgentGraph({
  model,
  tools = [],
  checkpointer,
  config = defaultConfig,
  datasetStore,
  normalizeRequest = createNormalizeRequestNode(),
  loadMemoryContext = async () => ({
    sessionMetadata: {},
    userMemory: [],
    recentSummary: {},
    messages: [],
    memoryErrors: []
  }),
  composePrompt = createComposePromptNode(),
  finalizeResponse = createFinalizeNode(),
  postTurnMemory = async () => ({}),
  observe = async () => ({}),
  confirmationNow = Date.now,
  operationStore
}) {
  if (!model || typeof model.bindTools !== 'function') {
    throw new TypeError('model must provide bindTools')
  }
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array')

  const invocationProvenance = new AsyncLocalStorage()
  const maxToolCalls = config?.agent?.maxToolCalls
  const adminTools = tools.filter(isAdminSqlTool)
  const baseTools = tools.filter(item => !isAdminSqlTool(item))
  const adminToolNames = new Set(adminTools.map(item => item.name))
  const domainToolNames = new Set(
    baseTools.filter(isDomainTool).map(item => item.name)
  )
  const adminSqlReachable = state =>
    config?.agent?.adminSqlEnabled === true &&
    state?.isAdmin === true &&
    analysisIntent(state?.intentType) &&
    invocationProvenance.getStore()?.domainGap === 'unsupported_depth'
  const baseValidateToolCall = createValidateToolCallNode({
    tools,
    datasetStore,
    maxToolCalls
  })
  const confirmationTtlSeconds = Number.isFinite(
    config?.agent?.confirmationTtlSeconds
  )
    ? config.agent.confirmationTtlSeconds
    : 1800
  const amountThreshold = Number.isFinite(config?.agent?.amountThreshold)
    ? config.agent.amountThreshold
    : 10_000
  const preparePendingConfirmation = createPendingConfirmationNode({
    tools,
    ttlMs: confirmationTtlSeconds * 1000,
    now: confirmationNow
  })
  const riskAndConfirmation = createRiskNode({
    amountThreshold,
    now: confirmationNow
  })
  const boundModel = model.bindTools(baseTools)
  const boundAdminModel = adminTools.length > 0
    ? model.bindTools([...baseTools, ...adminTools])
    : boundModel
  const toolsByName = new Map(tools.map(item => [item.name, item]))
  const toolNode = new ToolNode(safeExecutableTools(tools), {
    handleToolErrors: false
  })

  const validateToolCall = async (state, graphConfig) => {
    const result = await baseValidateToolCall(state, graphConfig)
    const errors = result.errors ?? []
    const fatalErrors = errors.filter(item => item?.fatal === true)

    // 如果有错误，且不是不可重试的错误，则把错误信息返回给模型，让它重试
    if (fatalErrors.length > 0) {
      const lastCalls = toolCallsFromLastMessage(state)
      const retryableErrors = fatalErrors.filter(e =>
        e.code === 'INVALID_TOOL_ARGUMENTS' ||
        e.code === 'DATASET_SCOPE_REJECTED'
      )

      // 只有可重试的错误才重试
      if (retryableErrors.length > 0 && lastCalls.length > 0) {
        // 生成错误的 tool message，让模型看到错误信息
        const errorMessages = lastCalls.map(call => toolMessage({
          id: call.id,
          name: call.name,
          value: {
            status: 'error',
            error: {
              code: retryableErrors[0].code,
              message: getErrorMessage(retryableErrors[0].code)
            }
          }
        }))

        return {
          messages: errorMessages,
          toolCallCount: result.toolCallCount ?? state.toolCallCount ?? 0
        }
      }

      // 不可重试的错误，直接返回
      return result
    }

    if (
      toolCallsFromLastMessage(state).some(call =>
        adminToolNames.has(call?.name)
      ) &&
      !adminSqlReachable(state)
    ) {
      return {
        errors: [safeError('FORBIDDEN', 'validate_tool_call')]
      }
    }
    if (!hasWriteToolCall(state)) return result
    return {
      ...result,
      ...await preparePendingConfirmation(state, graphConfig)
    }
  }

  const normalizeRequestScoped = async (state, graphConfig) => {
    const provenance = invocationProvenance.getStore()
    if (provenance) provenance.domainGap = null
    return normalizeRequest(state, graphConfig)
  }

  const callModel = async (state, graphConfig) => {
    try {
      const selectedModel = adminSqlReachable(state)
        ? boundAdminModel
        : boundModel
      const result = await selectedModel.invoke(
        composeModelMessages(state),
        graphConfig
      )
      if (!isAIMessage(result)) throw new TypeError('invalid model response')

      // Parse text-format tool calls (deepseek-v4-pro doesn't support native function calling)
      if ((!result.tool_calls || result.tool_calls.length === 0) && typeof result.content === 'string') {
        const parsed = parseTextToolCalls(result.content, toolsByName)
        if (parsed.toolCalls.length > 0) {
          const textContent = parsed.text || null
          const cleaned = new AIMessage({
            content: textContent,
            tool_calls: parsed.toolCalls
          })
          return { messages: [cleaned] }
        }
      }

      return { messages: [result] }
    } catch (err) {
      return {
        messages: [new AIMessage('')],
        errors: [safeError('MODEL_UNAVAILABLE', 'call_model')]
      }
    }
  }

  const domainTools = async (state, graphConfig) => {
    try {
      const invokesAdminSql = toolCallsFromLastMessage(state).some(call =>
        adminToolNames.has(call?.name)
      )
      const executionConfig = invokesAdminSql
        ? {
            ...graphConfig,
            context: {
              ...(graphConfig?.context ?? {}),
              intentType: state.intentType,
              domainGap: 'unsupported_depth'
            }
          }
        : graphConfig
      const output = await toolNode.invoke(state, executionConfig)
      const messages = Array.isArray(output?.messages) ? output.messages : []
      if (messages.some(message =>
        domainToolNames.has(message?.name) &&
        toolResult(message)?.status === 'unsupported_depth'
      )) {
        const provenance = invocationProvenance.getStore()
        if (provenance) provenance.domainGap = 'unsupported_depth'
      }
      const addedRefs = metadataFromToolMessages(messages)
      return {
        ...output,
        ...(addedRefs.length > 0
          ? { datasetRefs: mergeDatasetRefs(state.datasetRefs, addedRefs) }
          : {})
      }
    } catch {
      return {
        errors: [safeError('TOOL_EXECUTION_FAILED', 'domain_tools')]
      }
    }
  }

  const confirmedWriteTools = async (state, graphConfig) => {
    const pending = state.pendingConfirmation
    const sourceCalls = toolCallsFromLastMessage(state)
    const sourceCall = sourceCalls.find(
      call => call?.name === pending?.toolName
    )
    const failConfirmedWrite = code => ({
      messages: failedToolMessages(sourceCalls, code),
      ...(isValidPendingConfirmation(pending)
        ? {
            pendingConfirmation: {
              ...pending,
              approved: false,
              executed: true
            }
          }
        : {}),
      errors: [safeError(code, 'domain_tools')]
    })
    if (
      !isValidPendingConfirmation(pending) ||
      pending.approved !== true ||
      !sourceCall ||
      !operationStore ||
      typeof operationStore.claim !== 'function'
    ) {
      return failConfirmedWrite('CONFIRMATION_STATE_INVALID')
    }

    let claim
    try {
      claim = await operationStore.claim({
        userId: state.userId,
        operationId: pending.operationId,
        operationType: pending.toolName,
        input: pending.args
      })
    } catch {
      return failConfirmedWrite('TOOL_EXECUTION_FAILED')
    }

    if (claim.status === 'succeeded') {
      const replay = successfulToolResult([toolMessage({
        id: sourceCall.id,
        name: pending.toolName,
        value: claim.result
      })], sourceCall.id)
      if (!replay.success) {
        return failConfirmedWrite('TOOL_EXECUTION_FAILED')
      }
      return {
        messages: successfulWriteMessages(state, pending, sourceCalls, [toolMessage({
          id: sourceCall.id,
          name: pending.toolName,
          value: replay.result
        })]),
        pendingConfirmation: {
          ...pending,
          executed: true
        }
      }
    }
    if (claim.status === 'in_progress') {
      return failConfirmedWrite('OPERATION_IN_PROGRESS')
    }
    const expectedInputHash = hashOperation({
      operationType: pending.toolName,
      input: pending.args
    })
    if (
      claim.status !== 'owner' ||
      claim.inputHash !== expectedInputHash
    ) {
      return failConfirmedWrite('CONFIRMATION_STATE_INVALID')
    }

    const claimedConfig = {
      ...graphConfig,
      context: {
        ...(graphConfig?.context ?? {}),
        userId: state.userId,
        operationId: pending.operationId,
        operationPreclaim: {
          userId: state.userId,
          operationId: pending.operationId,
          operationType: pending.toolName,
          argsHash: pending.argsHash,
          inputHash: claim.inputHash
        }
      }
    }
    let output
    try {
      output = await toolNode.invoke({
        ...state,
        messages: [new AIMessage({
          content: '',
          tool_calls: [{
            id: sourceCall.id,
            name: pending.toolName,
            args: pending.args,
            type: 'tool_call'
          }]
        })]
      }, claimedConfig)
    } catch {
      if (
        toolsByName.get(pending.toolName)
          ?.metadata?.handlesOperationPreclaim !== true &&
        typeof operationStore.fail === 'function'
      ) {
        await operationStore.fail({
          userId: state.userId,
          operationId: pending.operationId,
          inputHash: claim.inputHash,
          errorCode: 'TOOL_EXECUTION_FAILED'
        }).catch(() => {})
      }
      return failConfirmedWrite('TOOL_EXECUTION_FAILED')
    }

    const executedMessages = Array.isArray(output?.messages)
      ? output.messages
      : []
    const toolHandlesClaim = toolsByName.get(pending.toolName)
      ?.metadata?.handlesOperationPreclaim === true
    const outcome = successfulToolResult(executedMessages, sourceCall.id)
    if (!outcome.success) {
      if (
        !toolHandlesClaim &&
        typeof operationStore.fail === 'function'
      ) {
        await operationStore.fail({
          userId: state.userId,
          operationId: pending.operationId,
          inputHash: claim.inputHash,
          errorCode: 'TOOL_EXECUTION_FAILED'
        }).catch(() => {})
      }
      return failConfirmedWrite('TOOL_EXECUTION_FAILED')
    }

    if (!toolHandlesClaim) {
      if (
        typeof operationStore.succeed !== 'function' ||
        typeof operationStore.fail !== 'function'
      ) {
        return failConfirmedWrite('CONFIRMATION_STATE_INVALID')
      }
      try {
        await operationStore.succeed({
          userId: state.userId,
          operationId: pending.operationId,
          inputHash: claim.inputHash,
          result: outcome.result
        })
      } catch {
        await operationStore.fail({
          userId: state.userId,
          operationId: pending.operationId,
          inputHash: claim.inputHash,
          errorCode: 'TOOL_EXECUTION_FAILED'
        }).catch(() => {})
        return failConfirmedWrite('TOOL_EXECUTION_FAILED')
      }
    }
    return {
      ...output,
      messages: successfulWriteMessages(
        state,
        pending,
        sourceCalls,
        executedMessages
      ),
      pendingConfirmation: {
        ...pending,
        executed: true
      }
    }
  }

  const routeModelResult = state => {
    if ((state.errors ?? []).some(item => item?.fatal === true)) {
      return 'finalize_response'
    }
    return toolCallsFromLastMessage(state).length > 0
      ? 'validate_tool_call'
      : 'finalize_response'
  }
  const routeValidation = state => {
    const lastMessage = state.messages?.at(-1)
    // 如果最后一条消息是 tool message（说明是验证错误返回的，可重试），则回到 call_model
    if (lastMessage?._getType?.() === 'tool' && (state.errors ?? []).length === 0) {
      return 'call_model'
    }
    if ((state.errors ?? []).some(item => item?.fatal === true)) {
      return 'finalize_response'
    }
    return hasWriteToolCall(state)
      ? 'risk_and_confirmation'
      : 'domain_tools'
  }
  const routeRiskAndConfirmation = state => {
    if ((state.errors ?? []).some(
      item => item?.fatal === true &&
        item?.code !== 'CONFIRMATION_EXPIRED'
    )) {
      return 'finalize_response'
    }
    return state.pendingConfirmation?.approved === true
      ? 'confirmed_write_tools'
      : 'terminate_confirmation'
  }
  const routeDomainTools = state =>
    (state.errors ?? []).some(item => item?.fatal === true)
      ? 'finalize_response'
      : 'call_model'
  const routeConfirmedWrite = state => {
    if ((state.errors ?? []).some(item => item?.fatal === true)) {
      return 'finalize_response'
    }
    return continuesAfterWrite(state)
      ? 'call_model'
      : 'finalize_response'
  }

  const graph = new StateGraph(AgentState)
    .addNode('normalize_request', normalizeRequestScoped)
    .addNode('load_memory_context', createLoadMemoryNode(loadMemoryContext))
    .addNode('compose_prompt', composePrompt)
    .addNode('call_model', callModel)
    .addNode('validate_tool_call', validateToolCall)
    .addNode('risk_and_confirmation', riskAndConfirmation)
    .addNode('terminate_confirmation', terminateConfirmation)
    .addNode('confirmed_write_tools', confirmedWriteTools)
    .addNode('domain_tools', domainTools)
    .addNode('finalize_response', finalizeResponse)
    .addNode('post_turn_memory', async (state, graphConfig) =>
      normalizeNodeResult(await postTurnMemory(state, graphConfig)))
    .addNode('observe', async (state, graphConfig) =>
      normalizeNodeResult(await observe(state, graphConfig)))
    .addEdge(START, 'normalize_request')
    .addEdge('normalize_request', 'load_memory_context')
    .addEdge('load_memory_context', 'compose_prompt')
    .addEdge('compose_prompt', 'call_model')
    .addConditionalEdges('call_model', routeModelResult, [
      'validate_tool_call',
      'finalize_response'
    ])
    .addConditionalEdges('validate_tool_call', routeValidation, [
      'risk_and_confirmation',
      'domain_tools',
      'finalize_response'
    ])
    .addConditionalEdges(
      'risk_and_confirmation',
      routeRiskAndConfirmation,
      [
        'confirmed_write_tools',
        'terminate_confirmation',
        'finalize_response'
      ]
    )
    .addConditionalEdges('confirmed_write_tools', routeConfirmedWrite, [
      'call_model',
      'finalize_response'
    ])
    .addConditionalEdges('domain_tools', routeDomainTools, [
      'call_model',
      'finalize_response'
    ])
    .addEdge('terminate_confirmation', 'post_turn_memory')
    .addEdge('finalize_response', 'post_turn_memory')
    .addEdge('post_turn_memory', 'observe')
    .addEdge('observe', END)

  const compiled = graph.compile({ checkpointer })
  const invoke = compiled.invoke.bind(compiled)
  compiled.invoke = (input, invocationConfig) =>
    invocationProvenance.run(
      { domainGap: null },
      () => invoke(input, invocationConfig)
    )
  return compiled
}
