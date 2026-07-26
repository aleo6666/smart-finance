import test from 'node:test'
import assert from 'node:assert/strict'
import { HumanMessage } from '@langchain/core/messages'
import {
  createSynthesisNode
} from '../../src/agent/nodes/synthesizeFinancialAnalysis.js'

function analysisFixture(extra = {}) {
  return {
    dataSufficiency: 'sufficient',
    objectiveAnalysis: ['food spending used 85% of budget'],
    overspentCategories: [],
    anomalies: [],
    nextMonthSuggestions: ['set a weekly food cap'],
    disclaimer: 'bookkeeping and budgeting reference only',
    ...extra
  }
}

function fixtureState(extra = {}) {
  return {
    messages: [new HumanMessage('analyze my bills')],
    userId: 7,
    sessionId: 'session-7',
    userMemory: [{ key: 'budget.food', value: 1000 }],
    recentSummary: { suggestions: ['cook twice a week'] },
    datasetRefs: [
      { datasetRef: 'ds_tx', count: 3 },
      { datasetRef: 'ds_budget', count: 1 }
    ],
    ...extra
  }
}

test('synthesis model is not bound to tools', async () => {
  let bound = false
  const model = {
    bindTools: () => { bound = true },
    withStructuredOutput: () => ({ invoke: async () => analysisFixture() })
  }

  await createSynthesisNode({
    model,
    datasetStore: { async get() { return { rows: [], summary: {} } } }
  })(fixtureState(), { context: { requestId: 'request-7' } })

  assert.equal(bound, false)
})

test('synthesis fetches scoped datasets and excludes raw window messages from payload', async () => {
  const getCalls = []
  let payload
  const model = {
    withStructuredOutput() {
      return {
        async invoke(messages) {
          payload = JSON.parse(messages.at(-1).content)
          return analysisFixture()
        }
      }
    }
  }
  const node = createSynthesisNode({
    model,
    datasetStore: {
      async get(input) {
        getCalls.push(input)
        return { rows: [{ amount: 25 }], summary: { total: 25 } }
      }
    }
  })

  const result = await node(fixtureState(), { context: { requestId: 'request-7' } })

  assert.deepEqual(getCalls, [
    { userId: 7, requestId: 'request-7', datasetRef: 'ds_tx' },
    { userId: 7, requestId: 'request-7', datasetRef: 'ds_budget' }
  ])
  assert.deepEqual(payload.userMemory, [{ key: 'budget.food', value: 1000 }])
  assert.deepEqual(payload.recentSummary, { suggestions: ['cook twice a week'] })
  assert.equal(Object.hasOwn(payload, 'messages'), false)
  assert.equal(result.response.type, 'financial_analysis')
})

test('synthesis passes through insufficient data without fabricating amounts', async () => {
  let payload
  const model = {
    withStructuredOutput() {
      return {
        async invoke(messages) {
          payload = JSON.parse(messages.at(-1).content)
          return analysisFixture({
            dataSufficiency: 'insufficient',
            objectiveAnalysis: ['not enough transaction data yet'],
            overspentCategories: [],
            anomalies: [],
            nextMonthSuggestions: ['record daily expenses before analysis'],
            disclaimer: 'bookkeeping and budgeting reference only'
          })
        }
      }
    }
  }

  const result = await createSynthesisNode({
    model,
    datasetStore: { async get() { return { rows: [], summary: { count: 0 } } } }
  })(fixtureState({ datasetRefs: [{ datasetRef: 'ds_empty', count: 0 }] }), {
    context: { requestId: 'request-7' }
  })

  assert.equal(result.response.dataSufficiency, 'insufficient')
  assert.doesNotMatch(JSON.stringify(result.response), /\d{2,}/)
  assert.deepEqual(payload.datasets, [{ rows: [], summary: { count: 0 } }])
})
