import { z } from 'zod'

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

export function createSynthesisNode({ model, datasetStore }) {
  if (!model || typeof model.withStructuredOutput !== 'function') {
    throw new TypeError('model must provide withStructuredOutput')
  }
  if (!datasetStore || typeof datasetStore.get !== 'function') {
    throw new TypeError('datasetStore must provide get')
  }
  const structuredModel = model.withStructuredOutput(FinancialAnalysisSchema)

  return async (state, config = {}) => {
    const datasets = await loadDatasets({ datasetStore, state, config })
    const analysis = await structuredModel.invoke([
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

    return {
      response: {
        type: 'financial_analysis',
        ...analysis
      }
    }
  }
}
