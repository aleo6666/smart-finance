import { Router } from 'express'
import db from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { formatReminder, sortReminderHighlights } from '../services/reminderPresenter.js'

function limitFromQuery(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

const currentMonth = new Date().toISOString().slice(0, 7)

/** 回溯检查：如果某预算已超阈值但缺少 pending reminder，补生成 */
async function ensureBudgetReminders(userId, dbClient) {
  const budgets = await dbClient('budgets').where('user_id', userId)

  for (const budget of budgets) {
    const row = await dbClient('records')
      .where({ user_id: userId, type: 'expense' })
      .whereRaw("DATE_FORMAT(date, '%Y-%m') = ?", [currentMonth])
      .where(builder => {
        if (budget.category) builder.where('category', budget.category)
      })
      .sum({ total: 'amount_cny' })
      .first()

    const spent = Number(row?.total || 0)
    const amount = Number(budget.amount)
    if (!amount) continue

    const percent = (spent / amount) * 100
    const level = percent >= 100 ? 'critical' : percent >= 80 ? 'warn' : null
    if (!level) continue

    // 已有 pending reminder 则跳过
    const category = budget.category || 'total'
    const existing = await dbClient('reminders')
      .where({ user_id: userId, type: 'budget_alert', status: 'pending' })
      .where('message', 'like', `%${currentMonth}%`)
      .where('message', 'like', `%${level}%`)
      .where('message', 'like', `%${category}%`)
      .first()
    if (existing) continue

    await dbClient('reminders').insert({
      device_id: `user-${userId}`,
      user_id: userId,
      type: 'budget_alert',
      title: `预算提醒：${budget.category || '总预算'} 已达到 ${level === 'critical' ? '100%' : '80%'}`,
      message: JSON.stringify({
        month: currentMonth,
        category,
        level,
        percent: Math.round(percent * 10) / 10,
        budget: amount,
        spent
      }),
      channel: 'inapp',
      status: 'pending'
    })
  }
}

export function createRemindersRouter({ dbClient = db } = {}) {
  const router = Router()
  router.use(authMiddleware)

  router.get('/', async (req, res) => {
    await ensureBudgetReminders(req.userId, dbClient)
    const limit = limitFromQuery(req.query.limit, 20, 50)
    const reminders = await dbClient('reminders')
      .where({ user_id: req.userId, status: 'pending' })
      .orderBy('created_at', 'desc')
      .limit(limit)
    res.json({ success: true, data: reminders.map(formatReminder) })
  })

  router.get('/highlights', async (req, res) => {
    await ensureBudgetReminders(req.userId, dbClient)
    const limit = limitFromQuery(req.query.limit, 3, 5)
    const reminders = await dbClient('reminders')
      .where({ user_id: req.userId, status: 'pending' })
      .orderBy('created_at', 'desc')
      .limit(50)
    const data = sortReminderHighlights(reminders.map(formatReminder)).slice(0, limit)
    res.json({ success: true, data })
  })

  router.get('/count', async (req, res) => {
    await ensureBudgetReminders(req.userId, dbClient)
    const row = await dbClient('reminders').where({ user_id: req.userId, status: 'pending' }).count({ count: '*' }).first()
    res.json({ success: true, data: Number(row?.count || 0) })
  })

  router.put('/read-all', async (req, res) => {
    await dbClient('reminders')
      .where({ user_id: req.userId, status: 'pending' })
      .update({ status: 'read', read_at: dbClient.fn.now() })
    res.json({ success: true, message: '全部已标记为已读' })
  })

  router.put('/:id/read', async (req, res) => {
    await dbClient('reminders')
      .where({ id: req.params.id, user_id: req.userId })
      .update({ status: 'read', read_at: dbClient.fn.now() })
    res.json({ success: true, message: '已标记为已读' })
  })

  router.post('/subscribe', async (req, res) => {
    const { templateId = process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID, openid } = req.body
    if (!openid) return res.status(400).json({ success: false, error: '缺少 openid' })
    await dbClient('wechat_subscribe')
      .insert({ user_id: req.userId, openid, template_id: templateId, status: 'authorized', authorized_at: dbClient.fn.now() })
      .onConflict(['user_id', 'template_id'])
      .merge({ openid, status: 'authorized', authorized_at: dbClient.fn.now() })
    res.json({ success: true })
  })

  return router
}

export default createRemindersRouter()
