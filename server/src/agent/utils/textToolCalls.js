import { jsonRepair } from './jsonRepair.js'

const TEXT_TOOL_ALIASES = {
  get_bills: 'query_transactions',
  add_bill: 'record_transaction',
  get_budgets: 'check_budget',
  calculate_budget: 'check_budget'
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

/**
 * 从模型文本输出中解析工具调用（用于不支持 native function calling 的模型如 DeepSeek v4 Pro）
 *
 * 支持 5 种 fallback 策略：
 * 1. ```json ``` 代码块
 * 2. 整体 JSON 解析（name + arguments）
 * 3. 嵌套 JSON 对象提取（括号计数器）
 * 4. 正则匹配 "tool"/"name" 字段
 * 5. 正则匹配参数关键字（兜底）
 *
 * @param {string} content - 模型输出的文本内容
 * @param {Set<string>} knownNames - 已知的工具名称集合
 * @returns {{ text: string, toolCalls: Array }} - 清理后的文本和解析出的工具调用
 */
export function parseTextToolCalls(content, knownNames) {
  if (typeof content !== 'string') return { text: content, toolCalls: [] }

  const blocks = []

  // 策略 0: 提取 ```json ``` 代码块
  const fenceRe = /```json\s*([\s\S]*?)\s*```/g
  let match
  while ((match = fenceRe.exec(content)) !== null) {
    blocks.push({ raw: match[0], json: match[1] })
  }

  if (blocks.length === 0) {
    // 策略 1: 尝试将整个文本解析为 JSON（支持 {name, arguments} 格式）
    const trimmed = content.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && (typeof parsed.name === 'string' || typeof parsed.tool === 'string')) {
          blocks.push({ raw: content, json: trimmed })
        }
      } catch {
        try {
          const repaired = jsonRepair(trimmed)
          const parsed = JSON.parse(repaired)
          if (parsed && (typeof parsed.name === 'string' || typeof parsed.tool === 'string')) {
            blocks.push({ raw: content, json: repaired })
          }
        } catch { /* 修复失败 */ }
      }
    }

    // 策略 2: 用括号计数器提取嵌套 JSON 对象
    if (blocks.length === 0) {
      const jsonCandidates = extractNestedJson(content)
      for (const jsonStr of jsonCandidates) {
        try {
          const parsed = JSON.parse(jsonStr)
          if (parsed && (typeof parsed.name === 'string' || typeof parsed.tool === 'string')) {
            blocks.push({ raw: jsonStr, json: jsonStr })
            break
          }
        } catch { /* 跳过 */ }
      }
    }

    // 策略 3: 正则匹配含 "tool" 或 "name" 字段的 JSON 对象
    if (blocks.length === 0) {
      const bareRe = /\{[^}]*"(tool|name)"\s*:\s*"[^"]*"[^}]*\}/g
      while ((match = bareRe.exec(content)) !== null) {
        blocks.push({ raw: match[0], json: match[0] })
      }
    }

    // 策略 4: 兜底 —— 匹配含常见参数名的 JSON 对象
    if (blocks.length === 0) {
      const paramRe = /\{[^}]*"(start_?date|end_?date|month|amount|category|type|query)"[^}]*\}/gi
      while ((match = paramRe.exec(content)) !== null) {
        blocks.push({ raw: match[0], json: match[0] })
      }
    }
  }

  const toolCalls = []
  let cleanContent = content
  for (const block of blocks) {
    let parsed = null
    try {
      parsed = JSON.parse(block.json.trim())
    } catch {
      try {
        const repaired = jsonRepair(block.json.trim())
        parsed = JSON.parse(repaired)
      } catch { /* 跳过 */ }
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

function hasQueryParams(obj) {
  if (!obj || typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  return keys.some(k => /^(start_?date|end_?date|month|amount|category|type|query)$/i.test(k, 0))
}

function guessToolByParams(obj) {
  if (!obj || typeof obj !== 'object') return null
  const keys = Object.keys(obj)
  if (keys.some(k => /^(start_?date|end_?date|month|category|type|query_kind|queryKind)$/i.test(k, 0))) {
    return 'query_transactions'
  }
  if (keys.some(k => /^(amount)$/i.test(k, 0))) {
    return 'record_transaction'
  }
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
