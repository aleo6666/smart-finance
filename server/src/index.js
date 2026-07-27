import dotenv from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env') })

import express from 'express'
import cors from 'cors'
import config from './config.js'
import { authLimiter, apiLimiter, strictLimiter } from './middleware/rateLimiter.js'
import db from './db.js'
import { ensureSchema } from './schema.js'
import { deviceIdMiddleware } from './middleware/deviceId.js'
import { createChatRouter } from './routes/chat.js'
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
import adviceRouter from './routes/advice.js'
import importRouter from './routes/import.js'
import { startScheduler } from './services/scheduler.js'
import { initVectorCollection, VectorDimensionError, createVectorClient } from './services/vectorMemory.js'
import defaultLmStudioClient from './services/lmStudioClient.js'
import getRedisClient from './redis.js'
import { createDefaultChecks } from './services/healthService.js'
import { createHealthRouter } from './routes/health.js'

const chatRouter = createChatRouter()

const app = express()

// 生产环境信任前端代理的 X-Forwarded-* 头
if (process.env.TRUST_PROXY === 'true' || config.server.nodeEnv === 'production') {
  app.set('trust proxy', 1)
}

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..')
mkdirSync(DATA_DIR, { recursive: true })

app.use(cors({
  origin: config.server.nodeEnv === 'production'
    ? ['https://lisheng666.xyz', 'https://www.lisheng666.xyz']
    : true,
  credentials: true
}))
app.use(express.json())
app.use(deviceIdMiddleware)

// 频率限制
app.use('/api/auth', authLimiter)
app.use('/api', apiLimiter)

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
app.use('/api/export', strictLimiter, exportRouter)
app.use('/api/observe', observeRouter)
app.use('/api/insights', insightsRouter)
app.use('/api/datasets', datasetsRouter)
app.use('/api/advice', adviceRouter)
app.use('/api/import', importRouter)

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

app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err)
  res.status(500).json({ success: false, error: '服务器内部错误' })
})

export async function bootstrap() {
  await ensureSchema(db)
  await initVectorCollection().catch(error => {
    if (error instanceof VectorDimensionError) {
      console.error('[Vector] 维度不匹配，请使用 reindex:rag 重建或删除旧集合后重试:', error.message)
    } else {
      console.warn('[Vector] init skipped:', error.message)
    }
  })

  // LangGraph Agent bootstrapping (before-knowledge vector init)
  if (config.agent.qdrantKnowledgeEnabled) {
    try {
      const { initKnowledgeCollection } = await import('./services/knowledgeVector.js')
      await initKnowledgeCollection({ embeddingClient: defaultLmStudioClient })
      console.log('[Knowledge] collection initialized')
    } catch (error) {
      console.warn('[Knowledge] init skipped:', error.message)
    }
  }

  if (config.agent.enabled) {
    try {
      await bootstrapAgent()
    } catch (error) {
      console.warn('[Agent] bootstrap skipped:', error.message)
    }
  }

  return app.listen(config.server.port, '0.0.0.0', () => {
    console.log(`Smart Finance API started: http://localhost:${config.server.port}`)
    startScheduler()
  })
}

async function bootstrapAgent() {
  const { createCheckpointer, CheckpointerSetupError } = await import('./agent/checkpointer.js')
  const { createFinanceModel } = await import('./agent/model.js')
  const { createAgentGraph } = await import('./agent/graph.js')
  const { buildRuntimeContext } = await import('./agent/runtime.js')
  const { createAgentService } = await import('./agent/service.js')

  let checkpointer
  try {
    checkpointer = await createCheckpointer()
  } catch (error) {
    if (error instanceof CheckpointerSetupError) throw error
    throw new CheckpointerSetupError()
  }

  const model = createFinanceModel({
    baseUrl: config.lmStudio.baseUrl,
    apiKey: config.lmStudio.apiKey,
    model: config.lmStudio.chatModel,
    maxRetries: config.agent.networkRetryCount
  })

  const graph = createAgentGraph({
    model,
    checkpointer,
    config
  })

  const legacyHandler = async (state, runtime) => ({
    success: true,
    data: {
      intent: 'chat',
      message: '',
      source: 'legacy'
    }
  })

  const agentService = createAgentService({
    config,
    graph,
    legacy: legacyHandler
  })

  // Re-create chat router with agent deps injected
  const newChatRouter = createChatRouter({
    agentService,
    buildRuntimeContext
  })

  // Replace the router reference used by Express middleware
  app._router.stack.forEach((layer, index) => {
    if (layer.route === undefined && layer.handle === chatRouter) {
      app._router.stack[index].handle = newChatRouter
    }
  })

  console.log('[Agent] LangGraph agent initialized')
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch(error => {
    console.error('[Bootstrap] failed:', error)
    process.exit(1)
  })
}

export default app
