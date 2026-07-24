import { Router } from 'express'
import multer from 'multer'
import { authMiddleware } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'
import importService from '../services/import/importService.js'

const upload = multer({ dest: process.env.UPLOADS_DIR || 'uploads' })
const logger = createLogger('Import')

const router = Router()
router.use(authMiddleware)

// ---- 1. 上传 CSV 文件创建导入批次 ----

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传文件' })
    }

    const { ledgerId } = req.body

    const result = await importService.createBatchFromFile({
      userId: req.userId,
      ledgerId: ledgerId || null,
      filePath: req.file.path,
      fileName: req.file.originalname
    })

    logger.info('创建导入批次', { userId: req.userId, batchId: result.id, sourceType: result.sourceType })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('上传解析失败', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ---- 2. 粘贴 CSV 文本创建导入批次 ----

router.post('/paste', async (req, res) => {
  try {
    const { content, ledgerId, fileName } = req.body
    if (!content) {
      return res.status(400).json({ success: false, error: '请粘贴账单内容' })
    }

    const result = await importService.createBatchFromContent({
      userId: req.userId,
      ledgerId: ledgerId || null,
      content,
      fileName: fileName || 'paste.csv'
    })

    logger.info('粘贴创建导入批次', { userId: req.userId, batchId: result.id })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('粘贴解析失败', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ---- 3. 导入历史列表 ----

router.get('/batches', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20

    const result = await importService.getBatchList({
      userId: req.userId,
      page,
      pageSize
    })

    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('获取导入历史失败', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ---- 4. 批次详情（含明细） ----

router.get('/:id', async (req, res) => {
  try {
    const result = await importService.getBatchDetail(req.params.id, req.userId)
    if (!result) {
      return res.status(404).json({ success: false, error: '批次不存在' })
    }
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('获取批次详情失败', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ---- 5. 修改单条明细（预览时人工编辑） ----

router.put('/:batchId/records/:recordId', async (req, res) => {
  try {
    const result = await importService.updateRecord({
      batchId: req.params.batchId,
      recordId: req.params.recordId,
      userId: req.userId,
      updates: req.body
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('更新明细失败', error)
    res.status(400).json({ success: false, error: error.message })
  }
})

// ---- 6. 批量切换选中状态 ----

router.post('/:batchId/select', async (req, res) => {
  try {
    const { recordIds, selected } = req.body
    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({ success: false, error: '请选择记录' })
    }

    const batch = await importService.getBatchDetail(req.params.batchId, req.userId)
    if (!batch) return res.status(404).json({ success: false, error: '批次不存在' })
    if (batch.status !== 'preview') {
      return res.status(400).json({ success: false, error: '仅预览状态可操作' })
    }

    // 批量更新
    const { default: db } = await import('../db.js')
    await db('import_records')
      .where({ batch_id: req.params.batchId, user_id: req.userId })
      .whereIn('id', recordIds)
      .update({ selected: selected ? 1 : 0 })

    const result = await importService.getBatchDetail(req.params.batchId, req.userId)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('批量选择失败', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ---- 7. 确认导入 ----

router.post('/:id/confirm', async (req, res) => {
  try {
    const { selectedIds } = req.body

    const result = await importService.confirmImport({
      batchId: req.params.id,
      userId: req.userId,
      selectedIds
    })

    logger.info('确认导入', { userId: req.userId, batchId: req.params.id, count: result.importedCount })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('确认导入失败', error)
    res.status(400).json({ success: false, error: error.message })
  }
})

// ---- 8. 回滚导入 ----

router.post('/:id/rollback', async (req, res) => {
  try {
    const result = await importService.rollbackBatch({
      batchId: req.params.id,
      userId: req.userId
    })

    logger.info('回滚导入', { userId: req.userId, batchId: req.params.id, count: result.rolledBackCount })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('回滚失败', error)
    res.status(400).json({ success: false, error: error.message })
  }
})

export default router
