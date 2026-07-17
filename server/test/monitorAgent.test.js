import test from 'node:test'
import assert from 'node:assert/strict'
import { checkBudgetAfterRecord } from '../src/services/monitorAgent.js'

test('checkBudgetAfterRecord creates reminder when spending reaches warning threshold', async () => {
  const reminders = []
  const repository = {
    async findBudgets(record) {
      assert.equal(record.category, '餐饮')
      return [{ id: 1, amount: 100, category: '餐饮' }]
    },
    async getMonthlySpend() {
      return 85
    },
    async findExistingReminder() {
      return null
    },
    async createReminder(reminder) {
      reminders.push(reminder)
      return { id: 11, ...reminder }
    }
  }

  const result = await checkBudgetAfterRecord({
    record: { user_id: 3, ledger_id: 1, type: 'expense', amount_cny: 25, category: '餐饮', date: '2026-07-17' },
    repository
  })

  assert.equal(result.alerts.length, 1)
  assert.equal(reminders[0].user_id, 3)
  assert.equal(reminders[0].type, 'budget_alert')
  assert.equal(reminders[0].status, 'pending')
  assert.match(reminders[0].title, /80%/)
})
