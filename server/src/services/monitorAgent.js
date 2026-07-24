import db from '../db.js'

function monthOf(date) {
  if (!date) return new Date().toISOString().slice(0, 7)
  if (date instanceof Date) return date.toISOString().slice(0, 7)
  return String(date).slice(0, 7)
}

export function createMonitorRepository(dbClient = db) {
  return {
    async findBudgets(record) {
      const query = dbClient('budgets')
        .where('user_id', record.user_id)
        .where(builder => {
          builder.whereNull('category').orWhere('category', record.category)
        })

      if (record.ledger_id) query.where(builder => builder.whereNull('ledger_id').orWhere('ledger_id', record.ledger_id))

      return query
    },

    async getMonthlySpend(record, budget) {
      const month = monthOf(record.date)
      const query = dbClient('records')
        .where('user_id', record.user_id)
        .where('type', 'expense')
        .whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [month])
        .sum({ total: 'amount_cny' })
        .first()

      if (budget.category) query.where('category', budget.category)
      if (record.ledger_id) query.where('ledger_id', record.ledger_id)

      const row = await query
      return Number(row?.total || 0)
    },

    async findExistingReminder(record, level, budget) {
      const month = monthOf(record.date)
      return dbClient('reminders')
        .where('user_id', record.user_id)
        .where('type', 'budget_alert')
        .where('status', 'pending')
        .where('message', 'like', `%${month}%`)
        .where('message', 'like', `%${level}%`)
        .where('message', 'like', `%${budget.category || 'total'}%`)
        .first()
    },

    async createReminder(reminder) {
      const [id] = await dbClient('reminders').insert(reminder)
      return { id, ...reminder }
    }
  }
}

export async function checkBudgetAfterRecord({ record, repository = createMonitorRepository() }) {
  if (!record || record.type !== 'expense' || !record.user_id) return { alerts: [] }

  const budgets = await repository.findBudgets(record)
  const alerts = []

  for (const budget of budgets) {
    const spent = await repository.getMonthlySpend(record, budget)
    const percent = budget.amount > 0 ? (spent / Number(budget.amount)) * 100 : 0
    const level = percent >= 100 ? 'critical' : percent >= 80 ? 'warn' : null
    if (!level) continue

    const existing = await repository.findExistingReminder(record, level, budget)
    if (existing) continue

    const month = monthOf(record.date)
    const category = budget.category || 'total'
    const reminder = await repository.createReminder({
      device_id: record.device_id || `user-${record.user_id}`,
      user_id: record.user_id,
      type: 'budget_alert',
      title: `预算提醒：${budget.category || '总预算'} 已达到 ${level === 'critical' ? '100%' : '80%'}`,
      message: JSON.stringify({ month, category, level, percent: Number(percent.toFixed(1)), budget: Number(budget.amount), spent }),
      channel: 'inapp',
      status: 'pending'
    })
    alerts.push(reminder)
  }

  return { alerts }
}
