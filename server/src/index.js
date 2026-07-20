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
import insightsRouter from './routes/insights.js'
import datasetsRouter from './routes/datasets.js'
import { startScheduler } from './services/scheduler.js'
import { initVectorCollection, VectorDimensionError, createVectorClient } from './services/vectorMemory.js'
import defaultLmStudioClient from './services/lmStudioClient.js'
import getRedisClient from './redis.js'
import { createDefaultChecks } from './services/healthService.js'
import { createHealthRouter } from './routes/health.js'

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
app.use('/api/insights', insightsRouter)
app.use('/api/datasets', datasetsRouter)

const uploadsDir = process.env.UPLOADS_DIR || 'uploads'
app.use('/uploads', express.static(uploadsDir))

app.use('/api/health', createHealthRouter({
  createChecks: () => createDefaultChecks({
    db,
    redis: getRedisClient(),
    qdrantClient: createVectorClient(),
    lmStudioClient: defaultLmStudioClient
  })
}))

export async function bootstrap() {
  await ensureSchema(db)
  await initVectorCollection().catch(error => {
    if (error instanceof VectorDimensionError) {
      console.error('[Vector] 维度不匹配，请使用 reindex:rag 重建或删除旧集合后重试:', error.message)
    } else {
      console.warn('[Vector] init skipped:', error.message)
    }
  })

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
