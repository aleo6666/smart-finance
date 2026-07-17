import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatReminder,
  sortReminderHighlights
} from '../src/services/reminderPresenter.js'

test('formatReminder turns budget warning JSON into display model', () => {
  const reminder = formatReminder({
    id: 1,
    type: 'budget_alert',
    title: '预算提醒',
    message: JSON.stringify({
      month: '2026-07',
      category: '餐饮',
      level: 'warn',
      percent: 86,
      budget: 1000,
      spent: 860
    }),
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  })

  assert.equal(reminder.display.kind, 'budget')
  assert.equal(reminder.display.level, 'warn')
  assert.equal(reminder.display.levelText, '接近预算')
  assert.equal(reminder.display.summary, '餐饮预算已使用 86%')
  assert.equal(reminder.display.detail, '2026-07 餐饮预算 ¥1000，已花 ¥860。')
  assert.equal(reminder.display.accent, 'warning')
})

test('formatReminder turns critical total budget into danger display', () => {
  const reminder = formatReminder({
    id: 2,
    type: 'budget_alert',
    title: '预算提醒',
    message: JSON.stringify({
      month: '2026-07',
      category: 'total',
      level: 'critical',
      percent: 103.5,
      budget: 3000,
      spent: 3105
    }),
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  })

  assert.equal(reminder.display.levelText, '已超预算')
  assert.equal(reminder.display.summary, '总预算已使用 103.5%')
  assert.equal(reminder.display.detail, '2026-07 总预算 ¥3000，已花 ¥3105。')
  assert.equal(reminder.display.accent, 'danger')
})

test('formatReminder falls back to generic display for non-json message', () => {
  const reminder = formatReminder({
    id: 3,
    type: 'daily',
    title: '每日提醒',
    message: '记得记账',
    status: 'pending',
    created_at: '2026-07-18T10:00:00.000Z'
  })

  assert.equal(reminder.display.kind, 'generic')
  assert.equal(reminder.display.level, 'info')
  assert.equal(reminder.display.summary, '每日提醒')
  assert.equal(reminder.display.detail, '记得记账')
})

test('sortReminderHighlights prioritizes critical then warn then time', () => {
  const reminders = [
    formatReminder({ id: 1, type: 'daily', title: '普通', message: '普通', created_at: '2026-07-18T12:00:00.000Z' }),
    formatReminder({ id: 2, type: 'budget_alert', title: 'warn', message: JSON.stringify({ level: 'warn', category: '餐饮', month: '2026-07', percent: 81, budget: 100, spent: 81 }), created_at: '2026-07-18T09:00:00.000Z' }),
    formatReminder({ id: 3, type: 'budget_alert', title: 'critical', message: JSON.stringify({ level: 'critical', category: '交通', month: '2026-07', percent: 101, budget: 100, spent: 101 }), created_at: '2026-07-18T08:00:00.000Z' })
  ]

  assert.deepEqual(sortReminderHighlights(reminders).map(item => item.id), [3, 2, 1])
})
