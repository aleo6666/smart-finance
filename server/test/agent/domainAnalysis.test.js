import test from 'node:test'
import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import { createDomainAnalysisSubgraph } from '../../src/agent/subgraphs/domainAnalysis.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fixtureState(extra = {}) {
  return {
    messages: [
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'analysis-1',
          name: 'query_transactions',
          args: { month: '2026-07', category: 'food' },
          type: 'tool_call'
        }]
      })
    ],
    userId: 7,
    sessionId: 'session-7',
    intentType: 'stat+analysis+suggest',
    datasetRefs: [],
    ...extra
  }
}

test('domain analysis waits for query and budget before calculation', async () => {
  const order = []
  const subgraph = createDomainAnalysisSubgraph({
    queryTransactions: async () => (await tick(), order.push('query'), { datasetRef: 'ds_tx' }),
    checkBudget: async () => (await tick(), order.push('budget'), { datasetRef: 'ds_budget' }),
    calculateFinanceMetrics: async input => {
      assert.deepEqual(new Set(input.datasetRefs), new Set(['ds_tx', 'ds_budget']))
      order.push('calculate')
      return { datasetRef: 'ds_metrics' }
    }
  })

  const result = await subgraph.invoke(fixtureState())

  assert.equal(order.at(-1), 'calculate')
  assert.equal(result.datasetRefs.at(-1).datasetRef, 'ds_metrics')
})

test('domain analysis starts query and budget before either one settles', async () => {
  const events = []
  let releaseQuery
  let releaseBudget
  const queryReady = new Promise(resolve => { releaseQuery = resolve })
  const budgetReady = new Promise(resolve => { releaseBudget = resolve })
  const subgraph = createDomainAnalysisSubgraph({
    queryTransactions: async () => {
      events.push('query-start')
      await budgetReady
      events.push('query-finish')
      return { datasetRef: 'ds_tx' }
    },
    checkBudget: async () => {
      events.push('budget-start')
      releaseQuery()
      await queryReady
      events.push('budget-finish')
      return { datasetRef: 'ds_budget' }
    },
    calculateFinanceMetrics: async () => ({ datasetRef: 'ds_metrics' })
  })

  const pending = subgraph.invoke(fixtureState())
  await tick()
  releaseBudget()
  const result = await pending

  assert.deepEqual(events.slice(0, 2).sort(), ['budget-start', 'query-start'])
  assert.equal(result.datasetRefs.at(-1).datasetRef, 'ds_metrics')
})

test('domain analysis preserves existing dataset refs and appends metadata only', async () => {
  const subgraph = createDomainAnalysisSubgraph({
    queryTransactions: async () => ({
      datasetRef: 'ds_tx',
      count: 2,
      scope: { month: '2026-07' },
      rows: [{ amount: 999 }]
    }),
    checkBudget: async () => ({
      datasetRef: 'ds_budget',
      count: 1,
      scope: { month: '2026-07' },
      summary: { secret: 'raw' }
    }),
    calculateFinanceMetrics: async () => ({ datasetRef: 'ds_metrics', count: 0 })
  })

  const result = await subgraph.invoke(fixtureState({
    datasetRefs: [{ datasetRef: 'ds_existing', count: 1 }]
  }))

  assert.deepEqual(result.datasetRefs, [
    { datasetRef: 'ds_existing', count: 1 },
    { datasetRef: 'ds_tx', count: 2, scope: { month: '2026-07' } },
    { datasetRef: 'ds_budget', count: 1, scope: { month: '2026-07' } },
    { datasetRef: 'ds_metrics', count: 0, scope: {} }
  ])
})
