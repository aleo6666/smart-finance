import dotenv from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env') })

import express from 'express'
import cors from 'cors'
import { deviceIdMiddleware } from './middleware/deviceId.js'
import chatRouter from './routes/chat.js'
import recordsRouter from './routes/records.js'
import reportsRouter from './routes/reports.js'
import goalsRouter from './routes/goals.js'
import remindersRouter from './routes/reminders.js'
import visionRouter from './routes/vision.js'
import feedbackRouter from './routes/feedback.js'
import exchangeRouter from './routes/exchange.js'
import { startScheduler } from './services/scheduler.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(deviceIdMiddleware)

// 路由
app.use('/api/chat', chatRouter)
app.use('/api/records', recordsRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/goals', goalsRouter)
app.use('/api/reminders', remindersRouter)
app.use('/api/vision', visionRouter)
app.use('/api/feedback', feedbackRouter)
app.use('/api/exchange', exchangeRouter)

// 静态文件：汇率看板等
app.use('/uploads', express.static('uploads'))

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: '财务记账助手服务运行中' })
})

app.listen(PORT, () => {
  console.log(`💰 智能财务记账助手服务已启动: http://localhost:${PORT}`)
  startScheduler()
})
