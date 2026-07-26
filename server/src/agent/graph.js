import {
  AIMessage,
  RemoveMessage,
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

const DATASET_SCOPE_FIELDS = new Set([
  'month',
  'startDate',
  'endDate',
  'category',
  'type',
  'queryKind'
])

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

function createFinalizeNode() {
  return async state => {
    const fatalErrors = (state.errors ?? []).filter(item => item?.fatal === true)
    const lastAi = [...(state.messages ?? [])].reverse().find(isAIMessage)
    const message = fatalErrors.length > 0
      ? '请求无法安全执行，请调整后重试。'
      : responseText(lastAi) || '暂时无法生成回复，请稍后重试。'
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
  observe = async () => ({})
}) {
  if (!model || typeof model.bindTools !== 'function') {
    throw new TypeError('model must provide bindTools')
  }
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array')

  const maxToolCalls = config?.agent?.maxToolCalls
  const validateToolCall = createValidateToolCallNode({
    tools,
    datasetStore,
    maxToolCalls
  })
  const boundModel = model.bindTools(tools)
  const toolNode = new ToolNode(safeExecutableTools(tools), {
    handleToolErrors: false
  })

  const callModel = async (state, graphConfig) => {
    try {
      const result = await boundModel.invoke(
        composeModelMessages(state),
        graphConfig
      )
      if (!isAIMessage(result)) throw new TypeError('invalid model response')
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
      const output = await toolNode.invoke(state, graphConfig)
      const messages = Array.isArray(output?.messages) ? output.messages : []
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

  const routeModelResult = state => {
    if ((state.errors ?? []).some(item => item?.fatal === true)) {
      return 'finalize_response'
    }
    return toolCallsFromLastMessage(state).length > 0
      ? 'validate_tool_call'
      : 'finalize_response'
  }
  const routeValidation = state =>
    (state.errors ?? []).some(item => item?.fatal === true)
      ? 'finalize_response'
      : 'domain_tools'

  const graph = new StateGraph(AgentState)
    .addNode('normalize_request', normalizeRequest)
    .addNode('load_memory_context', createLoadMemoryNode(loadMemoryContext))
    .addNode('compose_prompt', composePrompt)
    .addNode('call_model', callModel)
    .addNode('validate_tool_call', validateToolCall)
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
      'domain_tools',
      'finalize_response'
    ])
    .addEdge('domain_tools', 'call_model')
    .addEdge('finalize_response', 'post_turn_memory')
    .addEdge('post_turn_memory', 'observe')
    .addEdge('observe', END)

  return graph.compile({ checkpointer })
}
