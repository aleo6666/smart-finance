import { Router } from 'express'
import multer from 'multer'
import { scanReceipt } from '../services/vision.js'
import db from '../db.js'
import { updateHabitMemory } from '../services/memory.js'

const router = Router()

// 配置 multer - 限制文件大小5MB，只允许图片
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (allowed.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('仅支持 JPG/PNG/GIF/WebP 格式的图片'))
    }
  }
})

// 上传图片并识别
router.post('/', upload.single('image'), async (req, res) => {
  const { deviceId } = req

  if (!req.file) {
    return res.status(400).json({ success: false, error: '请上传一张购物小票或收据的截图' })
  }

  try {
    const result = await scanReceipt(req.file.path, deviceId)

    // 自动将识别结果存入数据库
    const savedRecords = []
    if (result.records && result.records.length > 0) {
      for (const r of result.records) {
        const { type = 'expense', amount, category = '其他', description = '', date } = r
        if (!amount) continue
        const recordDate = date || new Date().toISOString().slice(0, 10)

        db.prepare(
          'INSERT INTO records (device_id, type, amount, category, description, date) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(deviceId, type, amount, category, description, recordDate)

        if (type === 'expense') {
          updateHabitMemory(deviceId, category, amount)
        }
        savedRecords.push({ type, amount, category, description, date: recordDate })
      }
    }

    res.json({
      success: true,
      data: {
        summary: result.summary,
        totalAmount: result.totalAmount,
        records: savedRecords,
        count: savedRecords.length
      }
    })
  } catch (error) {
    console.error('[Upload] 处理失败:', error)
    res.status(500).json({ success: false, error: '图片处理失败: ' + error.message })
  }
})

export default router
