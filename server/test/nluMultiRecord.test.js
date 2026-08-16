import test from 'node:test'
import assert from 'node:assert/strict'
import { localParse, processMessage } from '../src/services/nlu.js'
import { createRecordTaskFromNlu } from '../src/services/plannerAgent.js'
import { recordFromPlannerTask } from '../src/services/recorderAgent.js'

function todayText() {
  return new Date().toISOString().slice(0, 10)
}

function yesterdayText() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

test('拆 2 笔："奶茶20和地铁5块"', async () => {
  const result = await localParse('奶茶20和地铁5块')

  assert.equal(result.intent, 'record')
  assert.equal(result.message, '已记录 2 笔：奶茶 ¥20.00、地铁 ¥5.00')
  assert.equal(result.data.records.length, 2)
  assert.deepEqual(result.data.records[0], { type: 'expense', amount: 20, category: '餐饮', description: '奶茶', date: todayText() })
  assert.deepEqual(result.data.records[1], { type: 'expense', amount: 5, category: '交通', description: '地铁', date: todayText() })
})

test('拆 3 笔："早餐8、咖啡15还有打车30"', async () => {
  const result = await localParse('早餐8、咖啡15还有打车30')

  assert.equal(result.intent, 'record')
  assert.equal(result.data.records.length, 3)
  assert.equal(result.data.records[0].description, '早餐')
  assert.equal(result.data.records[0].amount, 8)
  assert.equal(result.data.records[1].description, '咖啡')
  assert.equal(result.data.records[1].amount, 15)
  assert.equal(result.data.records[2].description, '打车')
  assert.equal(result.data.records[2].amount, 30)
  assert.match(result.message, /已记录 3 笔/)
})

test('不误拆："和牛套餐88"保持单笔', async () => {
  const result = await localParse('和牛套餐88')

  assert.equal(result.intent, 'record')
  assert.equal(result.data.amount, 88)
  assert.equal(result.data.records, undefined)
})

test('收入单笔："工资8000"', async () => {
  const result = await localParse('工资8000')

  assert.equal(result.intent, 'record')
  assert.equal(result.data.type, 'income')
  assert.equal(result.data.amount, 8000)
  assert.equal(result.data.records, undefined)
})

test('单笔回归："今天午饭花了25元"形状不变', async () => {
  const result = await localParse('今天午饭花了25元')

  assert.equal(result.intent, 'record')
  assert.equal(result.data.type, 'expense')
  assert.equal(result.data.amount, 25)
  assert.equal(result.data.records, undefined)
  assert.ok(result.data.date)
})

test('无金额子句被过滤："奶茶20和地铁"→1笔', async () => {
  const result = await localParse('奶茶20和地铁')

  assert.equal(result.intent, 'record')
  assert.equal(result.data.amount, 20)
  assert.equal(result.data.records, undefined)
})

test('日期继承："昨天奶茶20和地铁5块"两笔均为昨天', async () => {
  const result = await localParse('昨天奶茶20和地铁5块')

  assert.equal(result.data.records.length, 2)
  assert.equal(result.data.records[0].date, yesterdayText())
  assert.equal(result.data.records[1].date, yesterdayText())
})

test('LLM 不可用时纯规则可用', async () => {
  const throwingClient = { chat: async () => { throw new Error('LM Studio unreachable') } }

  const multi = await processMessage('user-1', '奶茶20和地铁5块', { lmStudioClient: throwingClient })
  assert.equal(multi.intent, 'record')
  assert.equal(multi.data.records.length, 2)

  const single = await processMessage('user-1', '今天午饭花了25元', { lmStudioClient: throwingClient })
  assert.equal(single.intent, 'record')
  assert.equal(single.data.amount, 25)
})

test('createRecordTaskFromNlu 将 data.records 映射为 payload.records', () => {
  const task = createRecordTaskFromNlu({
    userId: 1,
    deviceId: 'user-1',
    message: '奶茶20和地铁5块',
    nluResult: {
      intent: 'record',
      data: {
        records: [
          { type: 'expense', amount: 20, category: '餐饮', description: '奶茶', date: '2026-08-16' },
          { type: 'expense', amount: 5, category: '交通', description: '地铁', date: '2026-08-16' }
        ]
      }
    }
  })

  assert.equal(task.agentType, 'recorder')
  assert.equal(task.payload.records.length, 2)
  assert.equal(task.payload.records[0].amount, 20)
  assert.equal(task.payload.records[1].amount, 5)
  assert.equal(task.payload.record, undefined)
})

test('recordFromPlannerTask 批量循环入库', async () => {
  const inserted = []
  const repository = {
    async insertRecord(record) {
      inserted.push(record)
      return { ...record, id: inserted.length }
    }
  }

  const result = await recordFromPlannerTask({
    task: {
      taskId: 'task-batch',
      payload: {
        userId: 3,
        deviceId: 'user-3',
        records: [
          { type: 'expense', amount: 20, category: '餐饮', description: '奶茶', date: '2026-08-16' },
          { type: 'expense', amount: 5, category: '交通', description: '地铁', date: '2026-08-16' }
        ]
      }
    },
    repository,
    vectorMemory: { embedRecord: async () => {} },
    monitorAgent: { checkBudgetAfterRecord: async () => ({}) },
    observeService: { recordAgentEvent: async () => {} }
  })

  assert.deepEqual(result.recordIds, [1, 2])
  assert.equal(inserted.length, 2)
  assert.equal(inserted[0].amount, 20)
  assert.equal(inserted[1].amount, 5)
})
