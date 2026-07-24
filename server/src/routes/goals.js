import { Router } from 'express'
import db from '../db.js'
import { createLogger } from '../utils/logger.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
const logger = createLogger('Goals')
router.use(authMiddleware)

function makeDeviceId(req) {
  return `user-${req.userId}`
}

router.get('/', async (req, res) => {
  const query = db('goals').where({ user_id: req.userId })
  if (req.query.ledgerId) query.where('ledger_id', Number(req.query.ledgerId))
  res.json({ success: true, data: await query.orderBy('created_at', 'desc') })
})

router.post('/', async (req, res) => {
  const { name, target_amount, current_amount = 0, deadline, ledgerId } = req.body
  if (!name || !target_amount) return res.status(400).json({ success: false, error: '缺少必填字段: name, target_amount' })
  const [id] = await db('goals').insert({ device_id: makeDeviceId(req), user_id: req.userId, ledger_id: ledgerId ? Number(ledgerId) : null, name, target_amount, current_amount, deadline: deadline || null })
  logger.info('创建目标', { userId: req.userId, goalId: id, name })
  res.json({ success: true, data: await db('goals').where({ id }).first() })
})

router.put('/:id', async (req, res) => {
  const goal = await db('goals').where({ id: req.params.id, user_id: req.userId }).first()
  if (!goal) return res.status(404).json({ success: false, error: '目标不存在' })
  const updates = {}
  for (const key of ['current_amount', 'name', 'target_amount', 'deadline', 'completed']) {
    if (req.body[key] !== undefined) updates[key] = req.body[key]
  }
  if (Object.keys(updates).length) await db('goals').where({ id: req.params.id, user_id: req.userId }).update(updates)
  logger.info('修改目标', { userId: req.userId, goalId: req.params.id })
  res.json({ success: true, data: await db('goals').where({ id: req.params.id }).first() })
})

router.delete('/:id', async (req, res) => {
  const deleted = await db('goals').where({ id: req.params.id, user_id: req.userId }).delete()
  if (!deleted) return res.status(404).json({ success: false, error: '目标不存在' })
  logger.info('删除目标', { userId: req.userId, goalId: req.params.id })
  res.json({ success: true, message: '已删除' })
})

router.get('/budgets', async (req, res) => {
  const month = new Date().toISOString().slice(0, 7)
  const query = db('budgets').where({ user_id: req.userId })
  if (req.query.ledgerId) query.where('ledger_id', Number(req.query.ledgerId))
  const budgets = await query
  const data = []
  for (const budget of budgets) {
    const spendQuery = db('records')
      .where({ user_id: req.userId, type: 'expense' })
      .whereRaw('DATE_FORMAT(date, "%Y-%m") = ?', [month])
      .sum({ total: 'amount_cny' })
      .first()
    if (budget.category) spendQuery.where('category', budget.category)
    const row = await spendQuery
    const spent = Number(row?.total || 0)
    data.push({ ...budget, spent, percent: budget.amount > 0 ? Math.round(spent / budget.amount * 100) : 0 })
  }
  res.json({ success: true, data })
})

router.post('/budgets', async (req, res) => {
  const { category, amount, period = 'monthly', ledgerId } = req.body
  if (!amount) return res.status(400).json({ success: false, error: '缺少必填字段: amount' })

  const existing = await db('budgets')
    .where({ user_id: req.userId, period })
    .where(category ? { category } : builder => builder.whereNull('category'))
    .first()

  if (existing) {
    await db('budgets').where({ id: existing.id }).update({ amount, ledger_id: ledgerId ? Number(ledgerId) : null })
  } else {
    await db('budgets').insert({ device_id: makeDeviceId(req), user_id: req.userId, ledger_id: ledgerId ? Number(ledgerId) : null, category: category || null, amount, period })
  }

  logger.info('设置预算', { userId: req.userId, category: category || 'total', amount })
  res.json({ success: true, data: await db('budgets').where({ user_id: req.userId }) })
})

export default router
