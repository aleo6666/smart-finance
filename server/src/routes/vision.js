import { Router } from 'express'
import multer from 'multer'
import { scanReceipt } from '../services/vision.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

const uploadDir = process.env.UPLOADS_DIR || 'uploads'
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('仅支持 JPG/PNG/GIF/WebP 格式的图片'))
  }
})

// 上传图片并识别（只返回识别结果，不自动保存）
router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传一张购物小票或收据的截图' })
  }

  try {
    const result = await scanReceipt(req.file.path, req.userId)

    res.json({
      success: true,
      data: {
        summary: result.summary,
        totalAmount: result.totalAmount,
        records: result.records,
        count: (result.records || []).length
      }
    })
  } catch (error) {
    console.error('[Upload] 处理失败:', error)
    res.status(500).json({ success: false, error: '图片处理失败: ' + error.message })
  }
})

export default router
