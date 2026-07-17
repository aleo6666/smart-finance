import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createChatRouter } from '../src/routes/chat.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

test('POST /api/chat routes record intent through planner and recorder', async () => {
  const calls = { planned: 0, recorded: 0 }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 5,
    processMessage: async () => ({
      intent: 'record',
      message: '已记账',
      data: { type: 'expense', amount: 25, category: '餐饮', description: '午饭', date: '2026-07-17' }
    }),
    createRecordTaskFromNlu: input => {
      calls.planned += 1
      assert.equal(input.userId, 5)
      return { taskId: 'task-1', payload: { userId: 5, deviceId: 'device-1', record: input.nluResult.data } }
    },
    recordFromPlannerTask: async ({ task }) => {
      calls.recorded += 1
      assert.equal(task.taskId, 'task-1')
      return { recordIds: [99] }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '今天午饭花了25元' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.intent, 'record')
    assert.deepEqual(json.data.recordIds, [99])
    assert.equal(calls.planned, 1)
    assert.equal(calls.recorded, 1)
  } finally {
    server.close()
  }
})
