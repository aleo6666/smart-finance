import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { deviceIdMiddleware } from './middleware/deviceId.js'
import chatRouter from './routes/chat.js'
import recordsRouter from './routes/records.js'
import reportsRouter from './routes/reports.js'
import goalsRouter from './routes/goals.js'

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

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: '财务记账助手服务运行中' })
})

app.listen(PORT, () => {
  console.log(`💰 智能财务记账助手服务已启动: http://localhost:${PORT}`)
})
