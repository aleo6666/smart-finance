import { Router } from 'express'
import db from '../db.js'
import { getLatestRate } from '../services/exchangeRate.js'
import { authMiddleware } from '../middleware/auth.js'
import { scanReceipt } from '../services/vision.js'
import { embedRecord } from '../services/vectorMemory.js'
import { checkBudgetAfterRecord } from '../services/monitorAgent.js'
import multer from 'multer'

const router = Router()
router.use(authMiddleware)

const upload = multer({ dest: process.env.UPLOADS_DIR || 'uploads' })

function toCny(amount, currency) {
  if (!currency || currency === 'CNY') return amount
  const r = getLatestRate(currency)
  return r ? +(amount * r.rate).toFixed(2) : amount
}

async function fetchRecord(id, userId) {
  return db('records').where({ id, user_id: userId }).first()
}

router.get('/', async (req, res) => {
  const { ledgerId, month, category, type, member, merchant, project, sortBy = 'date', sortOrder = 'desc', page = 1, limit = 50 } = req.query
  const query = db('records as r')
    .select('r.*', db.raw('COALESCE(r.amount_cny, r.amount) as amount_cny'))
    .where('r.user_id', req.userId)

  if (ledgerId) query.where('r.ledger_id', Number(ledgerId))
  if (month) query.whereRaw('DATE_FORMAT(r.date, "%Y-%m") = ?', [month])
  if (category) query.where('r.category', category)
  if (type) query.where('r.type', type)
  if (member) query.where('r.member', member)
  if (merchant) query.where('r.merchant', 'like', `%${merchant}%`)
  if (project) query.where('r.project', project)

  const order = sortOrder === 'asc' ? 'asc' : 'desc'
  query.orderBy(sortBy === 'amount' ? 'amount_cny' : 'r.date', order).orderBy('r.created_at', order)
  query.limit(Number(limit)).offset((Number(page) - 1) * Number(limit))

  res.json({ success: true, data: await query })
})

router.post('/', async (req, res) => {
  const { type = 'expense', amount, category, description, date, ledgerId, currency = 'CNY', merchant, project, member } = req.body
  if (!amount || !category || !date) return res.status(400).json({ success: false, error: '缺少 amount/category/date' })

  const cnyAmount = toCny(Number(amount), currency)
  const [id] = await db('records').insert({
    device_id: `user-${req.userId}`,
    user_id: req.userId,
    ledger_id: ledgerId ? Number(ledgerId) : null,
    type,
    amount,
    currency,
    amount_cny: cnyAmount,
    category,
    description: description || '',
    merchant: merchant || null,
    project: project || null,
    member: member || null,
    date
  })

  const record = await fetchRecord(id, req.userId)
  await embedRecord(record).catch(error => console.warn('[Vector] embed skipped:', error.message))
  await checkBudgetAfterRecord({ record }).catch(error => console.warn('[Monitor] skipped:', error.message))
  res.json({ success: true, data: record })
})

router.put('/:id', async (req, res) => {
  const rec = await fetchRecord(req.params.id, req.userId)
  if (!rec) return res.status(404).json({ success: false, error: '记录不存在' })

  const { type, amount, category, description, date, currency, merchant, project, member } = req.body
  const nextCurrency = currency || rec.currency || 'CNY'
  const nextAmount = amount ?? rec.amount
  const cnyAmount = nextCurrency !== 'CNY' ? toCny(Number(nextAmount), nextCurrency) : nextAmount

  await db('records').where({ id: req.params.id, user_id: req.userId }).update({
    type: type || rec.type,
    amount: nextAmount,
    currency: nextCurrency,
    amount_cny: cnyAmount,
    category: category || rec.category,
    description: description !== undefined ? description : rec.description,
    date: date || rec.date,
    merchant: merchant !== undefined ? (merchant || null) : rec.merchant,
    project: project !== undefined ? (project || null) : rec.project,
    member: member !== undefined ? (member || null) : rec.member
  })

  res.json({ success: true, data: await fetchRecord(req.params.id, req.userId) })
})

router.delete('/:id', async (req, res) => {
  const rec = await fetchRecord(req.params.id, req.userId)
  if (!rec) return res.status(404).json({ success: false, error: '记录不存在' })
  await db('records').where({ id: req.params.id, user_id: req.userId }).delete()
  res.json({ success: true })
})

router.post('/import', async (req, res) => {
  const { csv } = req.body
  const lines = String(csv || '').split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return res.status(400).json({ success: false, error: 'CSV 内容不足' })

  const rows = lines.slice(1).map(line => {
    const c = line.split(',')
    const type = /收入|入账/.test(c[2] || '') ? 'income' : 'expense'
    const amount = parseFloat((c[3] || '0').replace(/[^\d.]/g, '')) || 0
    return {
      device_id: `user-${req.userId}`,
      user_id: req.userId,
      ledger_id: null,
      type,
      amount,
      currency: 'CNY',
      amount_cny: amount,
      category: c[1] || '其他',
      merchant: c[4] || '',
      date: (c[0] || '').slice(0, 10),
      description: c[5] || ''
    }
  }).filter(row => row.amount > 0 && row.date)

  if (rows.length) await db('records').insert(rows)
  res.json({ success: true, data: { imported: rows.length } })
})

router.post('/ocr', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: '缺少图片' })
  try {
    const result = await scanReceipt(req.file.path, req.userId)
    const savedRecords = []
    for (const rec of result.records || []) {
      if (!rec.amount) continue
      const [id] = await db('records').insert({
        device_id: `user-${req.userId}`,
        user_id: req.userId,
        type: rec.type || 'expense',
        amount: rec.amount,
        currency: 'CNY',
        amount_cny: rec.amount,
        category: rec.category || '其他',
        description: rec.description || '',
        merchant: rec.merchant || null,
        date: rec.date || new Date().toISOString().slice(0, 10)
      })
      const saved = await fetchRecord(id, req.userId)
      savedRecords.push(saved)
    }
    res.json({ success: true, data: { summary: result.summary, totalAmount: result.totalAmount, records: savedRecords, count: savedRecords.length } })
  } catch (error) {
    console.error('[OCR] failed:', error)
    res.status(500).json({ success: false, error: `图片处理失败: ${error.message}` })
  }
})

export default router
