import { z } from 'zod'
import { AIMessage } from '@langchain/core/messages'
import {
  buildEvidence,
  deterministicAnalysisText,
  deterministicPoints,
  resolveRecords,
  validatePoints,
  validateSummary
} from '../evidence.js'

export const FinancialAnalysisSchema = z.object({
  summary: z.string(),
  points: z.array(z.object({
    text: z.string(),
    recordIds: z.array(z.number().int().positive()).max(32)
  })).max(12)
})

const SYSTEM_PROMPT = [
  '你是一名记账与预算助手，只负责组织语言，不做任何计算。',
  '输入中的 evidence 是已算好的确定性证据块：所有数字与账单引用都已确定。',
  '你只能逐字引用 evidence 中的数字和 recordIds，禁止编造任何不在证据中的数字或记录。',
  '每个 point 的 text 中的数字必须来自证据块；recordIds 只能引用证据块中存在的记录。',
  '不要调用工具、不要修改记录、预算或记忆。',
  '不要提供投资产品、收益承诺或投资建议。',
  '只输出 JSON，不要输出任何其他文字或 markdown 代码块。JSON 格式：{"summary": "一句话总结", "points": [{"text": "结论文本", "recordIds": [1,2]}]}'
].join(' ')

// DeepSeek 等兼容端点不支持 response_format json_schema：
// 普通 invoke 后从文本中提取 JSON 并用 zod 容错解析。
function parseStructuredAnalysis(raw, schema) {
  const text = typeof raw === 'string'
    ? raw
    : (raw?.content ?? raw?.text ?? '')
  const jsonText = String(text)
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start === -1 || end <= start) throw new TypeError('LLM output has no JSON object')
  const parsed = JSON.parse(jsonText.slice(start, end + 1))
  const result = schema.safeParse(parsed)
  if (!result.success) throw new TypeError('LLM output failed schema validation')
  return result.data
}

function requestIdFrom(state, config) {
  return config?.context?.requestId ?? state?.requestId
}

async function loadDatasets({ datasetStore, state, config }) {
  const requestId = requestIdFrom(state, config)
  return Promise.all((state.datasetRefs ?? []).map(ref =>
    datasetStore.get({
      userId: state.userId,
      requestId,
      datasetRef: ref.datasetRef
    })
  ))
}

function formatList(items) {
  return (items?.length ?? 0) > 0
    ? items.map(item => `- ${item}`).join('\n')
    : '- （无）'
}

// 旧版结构化输出（dataSufficiency / objectiveAnalysis …）的文本渲染，保留以兼容历史调用方。
function formatAnalysisText(analysis) {
  const sufficiency = analysis?.dataSufficiency === 'sufficient'
    ? '数据充足'
    : '数据不足'
  return [
    '【财务分析】',
    `数据充分性：${sufficiency}`,
    '',
    '客观分析：',
    formatList(analysis?.objectiveAnalysis),
    '',
    '超支分类：',
    formatList(analysis?.overspentCategories),
    '',
    '异常提示：',
    formatList(analysis?.anomalies),
    '',
    '下月规划建议：',
    formatList(analysis?.nextMonthSuggestions),
    '',
    `免责声明：${analysis?.disclaimer ?? '本分析仅供记账与预算参考，不构成投资建议。'}`
  ].join('\n')
}

// 新版证据链输出（summary + points）的文本渲染。
function formatEvidenceAnalysisText(summary, points) {
  const lines = ['【财务分析】']
  if (summary) {
    lines.push(summary, '')
  }
  if (points.length > 0) {
    lines.push('分析要点：')
    for (const point of points) lines.push(`- ${point.text}`)
  } else {
    lines.push('当前账单数据不足，暂无法生成分析结论。')
  }
  lines.push('')
  lines.push('免责声明：本分析仅供记账与预算参考，不构成投资建议。')
  return lines.join('\n')
}

// 旧版结构化输出判定：仅测试/历史调用方可能返回该形状。
function isLegacyAnalysis(analysis) {
  return analysis?.dataSufficiency !== undefined ||
    Array.isArray(analysis?.objectiveAnalysis)
}

export function createSynthesisNode({ model, datasetStore }) {
  if (!model || typeof model.invoke !== 'function') {
    throw new TypeError('model must provide invoke')
  }
  if (!datasetStore || typeof datasetStore.get !== 'function') {
    throw new TypeError('datasetStore must provide get')
  }

  return async (state, config = {}) => {
    let datasets
    let evidence
    try {
      datasets = await loadDatasets({ datasetStore, state, config })
      evidence = buildEvidence(datasets)
    } catch (error) {
      console.error('[Synthesize] evidence build failed:', error?.message, error?.stack?.split('\n')[1] || '')
      return {
        errors: [{
          code: 'SYNTHESIS_FAILED',
          source: 'synthesize_analysis',
          fatal: true
        }]
      }
    }

    let analysis
    try {
      // DeepSeek 等兼容端点不支持 response_format json_schema → 用普通 invoke + JSON 提示 + 容错解析
      const raw = await model.invoke([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            evidence,
            datasets,
            userMemory: state.userMemory ?? [],
            recentSummary: state.recentSummary ?? {}
          })
        }
      ], config)
      analysis = parseStructuredAnalysis(raw, FinancialAnalysisSchema)
    } catch (error) {
      console.error('[Synthesize] structured invoke failed:', error?.message?.slice(0, 300))
      return {
        errors: [{
          code: 'SYNTHESIS_FAILED',
          source: 'synthesize_analysis',
          fatal: true
        }]
      }
    }

    // 结构化输出异常（空值/非对象）时降级为 fatal error，由 finalize 兜底，不中断主流程
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
      return {
        errors: [{
          code: 'SYNTHESIS_FAILED',
          source: 'synthesize_analysis',
          fatal: true
        }]
      }
    }

    // 引用校验：summary 与 points 中的数字/recordIds 必须与证据块一致，否则丢弃。
    const summary = validateSummary(analysis.summary, evidence)
    const { valid: validatedPoints } = validatePoints(analysis.points ?? [], evidence)

    // 无有效 LLM 内容时降级为纯确定性表述（不依赖 LLM）。
    const points = validatedPoints.length > 0
      ? validatedPoints
      : deterministicPoints(evidence)

    const text = isLegacyAnalysis(analysis)
      ? formatAnalysisText(analysis)
      : (summary || validatedPoints.length > 0
          ? formatEvidenceAnalysisText(summary, points)
          : deterministicAnalysisText(evidence))

    const evidencePayload = {
      summary,
      points: points.map(point => ({
        text: point.text,
        records: resolveRecords(point.recordIds, evidence)
      }))
    }

    return {
      // push 格式化文本为 AIMessage，供 finalize_response 取最后一条 AI 文本作为回复
      messages: [new AIMessage(text)],
      response: {
        type: 'financial_analysis',
        ...analysis,
        evidence: evidencePayload
      }
    }
  }
}
