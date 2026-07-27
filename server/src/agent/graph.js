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

function parseTextToolCalls(content, knownNames) {
  if (typeof content !== 'string') return { text: content, toolCalls: [] }

  const blocks = []
  const fenceRe = /```json\s*([\s\S]*?)\s*```/g
  let match
  while ((match = fenceRe.exec(content)) !== null) {
    blocks.push({ raw: match[0], json: match[1] })
  }

  if (blocks.length === 0) {
    const bareRe = /\{[^}]*"tool"\s*:\s*"[^"]*"[^}]*\}/g
    while ((match = bareRe.exec(content)) !== null) {
      blocks.push({ raw: match[0], json: match[0] })
    }
  }

  const toolCalls = []
  let cleanContent = content
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.json.trim())
      if (parsed && typeof parsed.tool === 'string') {
        const aliasName = parsed.tool
        const resolvedName = TEXT_TOOL_ALIASES[aliasName] || aliasName
        if (knownNames.has(resolvedName)) {
          toolCalls.push({
            id: `text_${Math.random().toString(36).slice(2, 10)}`,
            name: resolvedName,
            args: parsed.arguments || {}
          })
          cleanContent = cleanContent.replace(block.raw, '')
        }
      }
    } catch { /* ignore unparseable */ }
  }

  return { text: cleanContent.trim(), toolCalls }
}

function safeError(code, source) {
  return { code, source, fatal: true }
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
    if ((result.errors ?? []).some(item => item?.fatal === true)) return result
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
    } catch {
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
