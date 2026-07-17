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
  const calls = { planned: 0, recorded: 0, enqueued: 0, statuses: [] }
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
      return { taskId: 'task-1', agentType: 'recorder', payload: { userId: 5, deviceId: 'device-1', record: input.nluResult.data } }
    },
    recordFromPlannerTask: async ({ task }) => {
      calls.recorded += 1
      assert.equal(task.taskId, 'task-1')
      return { recordIds: [99] }
    },
    enqueueTask: async (agentType, payload, options) => {
      calls.enqueued += 1
      assert.equal(agentType, 'recorder')
      assert.equal(payload.userId, 5)
      assert.equal(options.taskId, 'task-1')
      return { taskId: 'task-1' }
    },
    markTaskStatus: async (taskId, status) => {
      calls.statuses.push({ taskId, status })
    },
    appendConversationMessage: async () => {}
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
    assert.equal(calls.enqueued, 1)
    assert.equal(calls.recorded, 1)
    assert.deepEqual(calls.statuses.map(item => item.status), ['running', 'succeeded'])
  } finally {
    server.close()
  }
})

test('POST /api/chat enhances query reply with retrieved records and context', async () => {
  const calls = { getContext: 0, appendContext: [], retrieve: [] }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 7,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async identity => {
      calls.getContext += 1
      assert.equal(identity, 'user-7')
      return [{ role: 'user', content: '刚才在看餐饮' }]
    },
    appendConversationMessage: async (identity, message) => {
      calls.appendContext.push({ identity, message })
    },
    retrieveSimilar: async (message, options) => {
      calls.retrieve.push({ message, options })
      return [{ recordId: 1, amount: 25, category: '餐饮', date: '2026-07-18' }]
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '本月餐饮花了多少' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.match(json.data.message, /找到 1 条相关记录/)
    assert.equal(calls.getContext, 1)
    assert.equal(calls.retrieve[0].options.userId, 7)
    assert.equal(calls.retrieve[0].options.category, '餐饮')
    assert.equal(calls.appendContext.length, 2)
  } finally {
    server.close()
  }
})

test('POST /api/chat skips long term retrieval for anonymous users', async () => {
  let retrieveCalled = false
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => null,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async () => [],
    appendConversationMessage: async () => {},
    retrieveSimilar: async () => { retrieveCalled = true; return [] }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '本月餐饮花了多少' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(retrieveCalled, false)
  } finally {
    server.close()
  }
})

test('POST /api/chat uses context hints and skips slow retrieval', async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.deviceId = 'device-1'
    next()
  })
  app.use('/api/chat', createChatRouter({
    getUserId: () => 7,
    processMessage: async () => ({ intent: 'query', message: '我可以帮你查看消费统计。', data: null }),
    getConversationContext: async () => [{ role: 'user', content: '刚才在看餐饮' }],
    appendConversationMessage: async () => {},
    retrieveSimilar: async (_message, options) => {
      assert.equal(options.month, '2026-06')
      assert.equal(options.category, '餐饮')
      return new Promise(() => {})
    }
  }))

  const { server, url } = await listen(app)
  try {
    const startedAt = Date.now()
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '那上月呢？' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.memory.records, 0)
    assert.deepEqual(json.data.memory.hints, { month: '2026-06', category: '餐饮' })
    assert.ok(Date.now() - startedAt < 1000)
  } finally {
    server.close()
  }
})

test('POST /api/chat appends context after record intent succeeds', async () => {
  const appended = []
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
    createRecordTaskFromNlu: input => ({ taskId: 'task-1', agentType: 'recorder', payload: { userId: 5, deviceId: 'device-1', record: input.nluResult.data } }),
    recordFromPlannerTask: async () => ({ recordIds: [99] }),
    enqueueTask: async () => ({ taskId: 'task-1' }),
    markTaskStatus: async () => {},
    appendConversationMessage: async (identity, message) => appended.push({ identity, message })
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
    assert.equal(appended.length, 2)
    assert.equal(appended[0].identity, 'user-5')
    assert.equal(appended[0].message.role, 'user')
    assert.equal(appended[1].message.role, 'assistant')
  } finally {
    server.close()
  }
})
