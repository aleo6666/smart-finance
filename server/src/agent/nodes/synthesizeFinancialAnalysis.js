import { z } from 'zod'
import { AIMessage } from '@langchain/core/messages'

export const FinancialAnalysisSchema = z.object({
  dataSufficiency: z.enum(['sufficient', 'insufficient']),
  objectiveAnalysis: z.array(z.string()).max(8),
  overspentCategories: z.array(z.string()).max(8),
  anomalies: z.array(z.string()).max(8),
  nextMonthSuggestions: z.array(z.string()).max(8),
  disclaimer: z.string()
})

const SYSTEM_PROMPT = [
  'Analyze only the provided temporary datasets, confirmed user memory, and recent summary.',
  'Do not call tools, mutate records, update budgets, or write memory.',
  'Do not fabricate transactions, amounts, ratios, or trends when data is missing.',
  'Give only bookkeeping, budgeting, and consumption-planning suggestions.',
  'Do not provide investment products, yield promises, or financial advisory instructions.'
].join(' ')

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

export function createSynthesisNode({ model, datasetStore }) {
  if (!model || typeof model.withStructuredOutput !== 'function') {
    throw new TypeError('model must provide withStructuredOutput')
  }
  if (!datasetStore || typeof datasetStore.get !== 'function') {
    throw new TypeError('datasetStore must provide get')
  }
  const structuredModel = model.withStructuredOutput(FinancialAnalysisSchema)

  return async (state, config = {}) => {
    let analysis
    try {
      const datasets = await loadDatasets({ datasetStore, state, config })
      analysis = await structuredModel.invoke([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            datasets,
            userMemory: state.userMemory ?? [],
            recentSummary: state.recentSummary ?? {}
          })
        }
      ], config)
    } catch {
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

    return {
      // push 格式化文本为 AIMessage，供 finalize_response 取最后一条 AI 文本作为回复
      messages: [new AIMessage(formatAnalysisText(analysis))],
      response: {
        type: 'financial_analysis',
        ...analysis
      }
    }
  }
}
