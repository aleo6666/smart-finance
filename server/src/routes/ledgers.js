import { Router } from 'express'
import db from '../db.js'
import { createLogger } from '../utils/logger.js'
import { authMiddleware } from '../middleware/auth.js'
import { assignOwnerRole } from '../middleware/rbac.js'

const router = Router()
const logger = createLogger('Ledgers')
router.use(authMiddleware)

router.get('/', async (req, res) => {
  const ledgers = await db('ledgers').where({ user_id: req.userId }).orderBy('created_at')
  res.json({ success: true, data: ledgers })
})

router.post('/', async (req, res) => {
  const { name, base_currency = 'CNY', icon, color } = req.body
  if (!name) return res.status(400).json({ success: false, error: '缺少账本名称' })
  const [id] = await db('ledgers').insert({ user_id: req.userId, name, base_currency, icon: icon || null, color: color || null })
  await assignOwnerRole(id, req.userId)
  const ledger = await db('ledgers').where({ id }).first()
  logger.info('创建账本', { userId: req.userId, ledgerId: id, name })
  res.json({ success: true, data: ledger })
})

router.put('/:id', async (req, res) => {
  const { name, base_currency, icon, color } = req.body
  await db('ledgers').where({ id: req.params.id, user_id: req.userId }).update({ name, base_currency, icon, color })
  const ledger = await db('ledgers').where({ id: req.params.id, user_id: req.userId }).first()
  logger.info('修改账本', { userId: req.userId, ledgerId: req.params.id })
  res.json({ success: true, data: ledger })
})

router.delete('/:id', async (req, res) => {
  await db('ledgers').where({ id: req.params.id, user_id: req.userId }).delete()
  logger.info('删除账本', { userId: req.userId, ledgerId: req.params.id })
  res.json({ success: true })
})

export default router
