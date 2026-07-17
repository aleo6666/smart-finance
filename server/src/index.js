import dotenv from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env') })

import express from 'express'
import cors from 'cors'
import config from './config.js'
import db from './db.js'
import { ensureSchema } from './schema.js'
import { deviceIdMiddleware } from './middleware/deviceId.js'
import chatRouter from './routes/chat.js'
import recordsRouter from './routes/records.js'
import reportsRouter from './routes/reports.js'
import goalsRouter from './routes/goals.js'
import remindersRouter from './routes/reminders.js'
import visionRouter from './routes/vision.js'
import feedbackRouter from './routes/feedback.js'
import exchangeRouter from './routes/exchange.js'
import authRouter from './routes/auth.js'
import ledgersRouter from './routes/ledgers.js'
import shareRouter from './routes/share.js'
import exportRouter from './routes/export.js'
import observeRouter from './routes/observe.js'
import { startScheduler } from './services/scheduler.js'
import { initVectorCollection } from './services/vectorMemory.js'

const app = express()

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..')
mkdirSync(DATA_DIR, { recursive: true })

app.use(cors())
app.use(express.json())
app.use(deviceIdMiddleware)

app.use('/api/chat', chatRouter)
app.use('/api/records', recordsRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/goals', goalsRouter)
app.use('/api/reminders', remindersRouter)
app.use('/api/vision', visionRouter)
app.use('/api/feedback', feedbackRouter)
app.use('/api/exchange', exchangeRouter)
app.use('/api/auth', authRouter)
app.use('/api/ledgers', ledgersRouter)
app.use('/api/share', shareRouter)
app.use('/api/export', exportRouter)
app.use('/api/observe', observeRouter)

const uploadsDir = process.env.UPLOADS_DIR || 'uploads'
app.use('/uploads', express.static(uploadsDir))

app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: '智能财务记账助手服务运行中' })
})

export async function bootstrap() {
  await ensureSchema(db)
  await initVectorCollection().catch(error => console.warn('[Vector] init skipped:', error.message))

  return app.listen(config.server.port, '0.0.0.0', () => {
    console.log(`Smart Finance API started: http://localhost:${config.server.port}`)
    startScheduler()
  })
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch(error => {
    console.error('[Bootstrap] failed:', error)
    process.exit(1)
  })
}

export default app
