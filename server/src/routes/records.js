import { Router } from 'express'
import db from '../db.js'
import config from '../config.js'
import { getLatestRate } from '../services/exchangeRate.js'
import { authMiddleware } from '../middleware/auth.js'
import { scanReceipt } from '../services/vision.js'
import { createLogger } from '../utils/logger.js'
import * as defaultVectorMemory from '../services/vectorMemory.js'
import { checkBudgetAfterRecord } from '../services/monitorAgent.js'
import {
  saveOcrSession,
  readOcrSession,
  clearOcrSession
} from '../services/ocrSession.js'
import {
  createOcrConfirmOperationId,
  saveConfirmedOcrRecords
} from '../services/ocrConfirm.js'
import { createOperationStore } from '../agent/stores/operationStore.js'
import { manualOcrFallback } from '../agent/tools/ocrTool.js'
import multer from 'multer'

const upload = multer({ dest: process.env.UPLOADS_DIR || 'uploads' })
const logger = createLogger('Records')

async function toCny(amount, currency) {
  if (!currency || currency === 'CNY') return amount
  const r = await getLatestRate(currency)
  return r ? +(amount * Number(r.rate)).toFixed(2) : amount
}

export function createRecordsRouter({
  dbClient = db,
  scanReceiptFn = scanReceipt,
  ocrSessionService = { saveOcrSession, readOcrSession, clearOcrSession },
  ocrConfirmService = { saveConfirmedOcrRecords },
  operationStore = createOperationStore(dbClient),
  vectorMemory = defaultVectorMemory,
  billVectorWriteEnabled = config.agent.billVectorWriteEnabled
} = {}) {
  const router = Router()
  router.use(authMiddleware)

  async function fetchRecord(id, userId) {
    return dbClient('records').where({ id, user_id: userId }).first()
  }

  router.get('/', async (req, res) => {
    const { ledgerId, month, category, type, member, merchant, project, sortBy = 'date', sortOrder = 'desc', page = 1, limit = 50 } = req.query
    const query = dbClient('records as r')
      .select('r.*', dbClient.raw('COALESCE(r.amount_cny, r.amount) as amount_cny'))
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

    const cnyAmount = await toCny(Number(amount), currency)
    const [id] = await dbClient('records').insert({
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
    if (billVectorWriteEnabled) {
      vectorMemory.embedRecord(record).catch(error => console.warn('[Vector] embed skipped for record id=' + id + ':', error.message))
    }
    await checkBudgetAfterRecord({ record }).catch(error => console.warn('[Monitor] skipped:', error.message))
    logger.info('创建记账记录', { userId: req.userId, recordId: id, amount, category, type })
    res.json({ success: true, data: record })
  })

  router.put('/:id', async (req, res) => {
    const rec = await fetchRecord(req.params.id, req.userId)
    if (!rec) return res.status(404).json({ success: false, error: '记录不存在' })

    const { type, amount, category, description, date, currency, merchant, project, member } = req.body
    const nextCurrency = currency || rec.currency || 'CNY'
    const nextAmount = amount ?? rec.amount
    const cnyAmount = nextCurrency !== 'CNY' ? await toCny(Number(nextAmount), nextCurrency) : nextAmount

    // 统一日期格式
    let nextDate = date || rec.date
    if (nextDate && typeof nextDate === 'string') {
      if (nextDate.includes('T')) {
        nextDate = nextDate.split('T')[0]
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
        try {
          const d = new Date(nextDate)
          if (!isNaN(d.getTime())) {
            nextDate = d.toISOString().slice(0, 10)
          }
        } catch {
          nextDate = rec.date
        }
      }
    }

    await dbClient('records').where({ id: req.params.id, user_id: req.userId }).update({
      type: type || rec.type,
      amount: nextAmount,
      currency: nextCurrency,
      amount_cny: cnyAmount,
      category: category || rec.category,
      description: description !== undefined ? description : rec.description,
      date: nextDate,
      merchant: merchant !== undefined ? (merchant || null) : rec.merchant,
      project: project !== undefined ? (project || null) : rec.project,
      member: member !== undefined ? (member || null) : rec.member
    })

    const updated = await fetchRecord(req.params.id, req.userId)
    if (billVectorWriteEnabled) {
      vectorMemory.embedRecord(updated).catch(error => console.warn('[Vector] re-index skipped for record id=' + req.params.id + ':', error.message))
    }
    logger.info('修改记账记录', { userId: req.userId, recordId: req.params.id })
    res.json({ success: true, data: updated })
  })

  router.delete('/:id', async (req, res) => {
    const rec = await fetchRecord(req.params.id, req.userId)
    if (!rec) return res.status(404).json({ success: false, error: '记录不存在' })
    await dbClient('records').where({ id: req.params.id, user_id: req.userId }).delete()
    if (billVectorWriteEnabled) {
      vectorMemory.deleteRecordVector(req.params.id).catch(error => console.warn('[Vector] delete skipped for record id=' + req.params.id + ':', error.message))
    }
    logger.info('删除记账记录', { userId: req.userId, recordId: req.params.id })
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

    if (rows.length) await dbClient('records').insert(rows)
    logger.info('CSV导入记账记录', { userId: req.userId, count: rows.length })
    res.json({ success: true, data: { imported: rows.length } })
  })

  router.post('/ocr', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '缺少图片' })
    try {
      const result = await scanReceiptFn(req.file.path, req.userId)
      const records = Array.isArray(result.records) ? result.records : []

      if (records.length === 0) {
        return res.json({
          success: true,
          data: {
            summary: result.summary,
            totalAmount: result.totalAmount || 0,
            records: [],
            count: 0
          }
        })
      }

      const session = await ocrSessionService.saveOcrSession({
        userId: req.userId,
        file: req.file,
        result: { ...result, records }
      })

      res.json({
        success: true,
        data: {
          ocrSessionId: session.ocrSessionId,
          summary: result.summary,
          totalAmount: result.totalAmount || records.reduce((sum, record) => sum + Number(record.amount || 0), 0),
          records,
          count: records.length,
          expiresInSeconds: session.expiresInSeconds
        }
      })
    } catch (error) {
      logger.warn('OCR provider unavailable', { userId: req.userId })
      res.json({ success: true, data: manualOcrFallback('OCR_UNAVAILABLE') })
    }
  })

  router.post('/ocr/confirm', async (req, res) => {
    const { ocrSessionId, records } = req.body || {}
    const session = await ocrSessionService.readOcrSession({ userId: req.userId, ocrSessionId })
    if (!session) return res.status(404).json({ success: false, error: '识别结果已过期，请重新上传图片' })

    try {
      const result = await ocrConfirmService.saveConfirmedOcrRecords({
        userId: req.userId,
        deviceId: `user-${req.userId}`,
        session,
        uploadId: ocrSessionId,
        operationId: createOcrConfirmOperationId({
          userId: req.userId,
          uploadId: ocrSessionId
        }),
        operationStore,
        confirmedRecords: records
      })
      logger.info('OCR确认保存记录', { userId: req.userId, count: result.count })
      res.json({ success: true, data: result })
    } catch (error) {
      logger.warn('OCR confirmation failed', { userId: req.userId })
      res.status(400).json({ success: false, error: '保存记录失败，请检查数据后重试' })
    }
  })

  router.post('/ocr/cancel', async (req, res) => {
    const { ocrSessionId } = req.body || {}
    await ocrSessionService.clearOcrSession({ userId: req.userId, ocrSessionId })
    res.json({ success: true })
  })

  return router
}

export default createRecordsRouter()
