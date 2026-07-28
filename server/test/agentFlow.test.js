import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecordTaskFromNlu } from '../src/services/plannerAgent.js'
import { recordFromPlannerTask } from '../src/services/recorderAgent.js'

test('createRecordTaskFromNlu creates recorder task for record intent', () => {
  const task = createRecordTaskFromNlu({
    userId: 3,
    deviceId: 'user-3',
    message: '今天午饭花了25元',
    nluResult: {
      intent: 'record',
      data: { type: 'expense', amount: 25, category: '餐饮', description: '午饭', date: '2026-07-17' }
    }
  })

  assert.equal(task.agentType, 'recorder')
  assert.equal(task.intent, 'record')
  assert.equal(task.payload.userId, 3)
  assert.equal(task.payload.record.amount, 25)
})

test('recordFromPlannerTask inserts record and embeds vector', async () => {
  const inserted = []
  const embedded = []
  const monitored = []
  const observed = []
  const repository = {
    async insertRecord(record) {
      inserted.push(record)
      return { ...record, id: 42 }
    }
  }

  const result = await recordFromPlannerTask({
    task: {
      taskId: 'task-1',
      payload: {
        userId: 3,
        deviceId: 'user-3',
        record: { type: 'expense', amount: 25, category: '餐饮', description: '午饭', date: '2026-07-17' }
      }
    },
    repository,
    vectorMemory: { embedRecord: async record => embedded.push(record) },
    monitorAgent: { checkBudgetAfterRecord: async input => monitored.push(input) },
    observeService: { recordAgentEvent: async event => observed.push(event) },
    billVectorWriteEnabled: true
  })

  assert.equal(result.recordIds[0], 42)
  assert.equal(result.vectorIndexed, true)
  assert.equal(inserted[0].device_id, 'user-3')
  assert.equal(inserted[0].amount_cny, 25)
  assert.equal(embedded[0].id, 42)
  assert.equal(monitored[0].record.id, 42)
  assert.equal(observed[0].status, 'succeeded')
  assert.equal(observed[0].vectorIndexed, true)
})

test('recordFromPlannerTask returns recordId and vectorIndexed false when embedRecord throws', async () => {
  const observed = []
  const repository = {
    async insertRecord(record) {
      return { ...record, id: 99 }
    }
  }

  const result = await recordFromPlannerTask({
    task: {
      taskId: 'task-2',
      payload: {
        userId: 3,
        deviceId: 'user-3',
        record: { type: 'expense', amount: 50, category: '交通', description: '打车', date: '2026-07-18' }
      }
    },
    repository,
    vectorMemory: {
      embedRecord: async () => { throw new Error('LM Studio unreachable') }
    },
    monitorAgent: { checkBudgetAfterRecord: async () => ({}) },
    observeService: { recordAgentEvent: async event => observed.push(event) },
    billVectorWriteEnabled: true
  })

  assert.equal(result.recordIds[0], 99)
  assert.equal(result.vectorIndexed, false)
  assert.equal(observed[0].status, 'succeeded')
  assert.equal(observed[0].vectorIndexed, false)
})
