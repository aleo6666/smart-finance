import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'http'
import { createRecordsRouter } from '../src/routes/records.js'
import { signToken } from '../src/middleware/auth.js'

function listen(app) {
  const server = createServer(app)
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function createMockKnex() {
  let nextId = 1
  const store = []

  function table() {
    return {
      where(conditions) {
        const match = (r) => Object.entries(conditions).every(([k, v]) => String(r[k]) === String(v))
        return {
          async first() {
            return store.find(match) || undefined
          },
          async update(data) {
            const idx = store.findIndex(match)
            if (idx >= 0) Object.assign(store[idx], data)
          },
          async delete() {
            const idx = store.findIndex(match)
            if (idx >= 0) store.splice(idx, 1)
          }
        }
      },
      async insert(data) {
        const records = Array.isArray(data) ? data : [data]
        return records.map(r => {
          const id = nextId++
          store.push({ ...r, id })
          return id
        })
      }
    }
  }

  table.raw = (sql) => sql
  return table
}

test('POST /api/records indexes record after DB insert', async () => {
  const indexed = []
  const dbClient = createMockKnex()
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    dbClient,
    vectorMemory: {
      embedRecord: async record => indexed.push(record),
      deleteRecordVector: async () => {}
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: 100, category: '餐饮', date: '2026-07-17', type: 'expense' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.ok(json.data.id, 'record should have an id')
    assert.equal(indexed.length, 1)
    assert.equal(indexed[0].id, json.data.id)
    assert.equal(indexed[0].amount, 100)
  } finally {
    server.close()
  }
})

test('POST /api/records succeeds even when embedRecord throws', async () => {
  const dbClient = createMockKnex()
  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    dbClient,
    vectorMemory: {
      embedRecord: async () => { throw new Error('Qdrant down') },
      deleteRecordVector: async () => {}
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: 200, category: '交通', date: '2026-07-17', type: 'expense' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.ok(json.data.id)
    assert.equal(json.data.amount, 200)
  } finally {
    server.close()
  }
})

test('PUT /api/records/:id re-fetches and re-indexes updated row', async () => {
  const indexed = []
  const dbClient = createMockKnex()

  // Pre-insert a record
  const [id] = await dbClient('records').insert({
    device_id: 'user-7', user_id: 7, type: 'expense', amount: 50,
    currency: 'CNY', amount_cny: 50, category: '购物', description: '',
    date: '2026-07-17', merchant: null, project: null, member: null,
    ledger_id: null
  })

  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    dbClient,
    vectorMemory: {
      embedRecord: async record => indexed.push(record),
      deleteRecordVector: async () => {}
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: 150, category: '购物' })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.amount, 150)

    // Should have re-indexed the updated row
    assert.equal(indexed.length, 1)
    assert.equal(indexed[0].id, id)
    assert.equal(indexed[0].amount, 150)
  } finally {
    server.close()
  }
})

test('PUT /api/records/:id succeeds even when vector re-index throws', async () => {
  const dbClient = createMockKnex()

  const [id] = await dbClient('records').insert({
    device_id: 'user-7', user_id: 7, type: 'expense', amount: 50,
    currency: 'CNY', amount_cny: 50, category: '购物', description: '',
    date: '2026-07-17', merchant: null, project: null, member: null,
    ledger_id: null
  })

  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    dbClient,
    vectorMemory: {
      embedRecord: async () => { throw new Error('Qdrant write error') },
      deleteRecordVector: async () => {}
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${signToken(7)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount: 300 })
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(json.data.amount, 300)
  } finally {
    server.close()
  }
})

test('DELETE /api/records/:id removes corresponding vector', async () => {
  const deleted = []
  const dbClient = createMockKnex()

  const [id] = await dbClient('records').insert({
    device_id: 'user-7', user_id: 7, type: 'expense', amount: 50,
    currency: 'CNY', amount_cny: 50, category: '购物', description: '',
    date: '2026-07-17', merchant: null, project: null, member: null,
    ledger_id: null
  })

  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    dbClient,
    vectorMemory: {
      embedRecord: async () => {},
      deleteRecordVector: async recordId => deleted.push(Number(recordId))
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
    assert.equal(deleted.length, 1)
    assert.equal(deleted[0], id)
  } finally {
    server.close()
  }
})

test('DELETE /api/records/:id succeeds even when vector deletion throws', async () => {
  const dbClient = createMockKnex()

  const [id] = await dbClient('records').insert({
    device_id: 'user-7', user_id: 7, type: 'expense', amount: 50,
    currency: 'CNY', amount_cny: 50, category: '购物', description: '',
    date: '2026-07-17', merchant: null, project: null, member: null,
    ledger_id: null
  })

  const app = express()
  app.use(express.json())
  app.use('/api/records', createRecordsRouter({
    dbClient,
    vectorMemory: {
      embedRecord: async () => {},
      deleteRecordVector: async () => { throw new Error('Qdrant delete failure') }
    }
  }))

  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/api/records/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${signToken(7)}` }
    })
    const json = await response.json()

    assert.equal(response.status, 200)
    assert.equal(json.success, true)
  } finally {
    server.close()
  }
})
