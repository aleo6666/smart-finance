import { createHash } from 'crypto'
import { QdrantClient } from '@qdrant/js-client-rest'
import config from '../config.js'
import defaultLmStudioClient from './lmStudioClient.js'

export class VectorDimensionError extends Error {
  constructor(expected, actual) {
    super(`向量集合维度不匹配：集合=${expected}，模型=${actual}`)
    this.name = 'VectorDimensionError'
  }
}

export function createDeterministicEmbedding(text, size = 1536) {
  const vector = []
  let seed = String(text || '')

  while (vector.length < size) {
    const hash = createHash('sha256').update(seed).digest()
    for (const byte of hash) {
      vector.push(Number(((byte / 127.5) - 1).toFixed(6)))
      if (vector.length === size) break
    }
    seed = hash.toString('hex')
  }

  return vector
}

export function recordToTextBlock(record) {
  const typeText = record.type === 'income' ? '收入' : '支出'
  const amount = record.amount_cny ?? record.amount
  return [
    record.date,
    `${typeText}${amount}元`,
    `分类:${record.category}`,
    record.merchant ? `商家:${record.merchant}` : '',
    record.description ? `备注:${record.description}` : ''
  ].filter(Boolean).join('，')
}

export function createVectorClient() {
  return new QdrantClient({ url: config.vector.url })
}

export async function getEmbedding(text, { embeddingClient = defaultLmStudioClient } = {}) {
  return embeddingClient.embed(text)
}

export async function initVectorCollection({
  client = createVectorClient(),
  collection = config.rag.collection,
  embeddingClient = defaultLmStudioClient
} = {}) {
  const probeVector = await embeddingClient.embed('维度探针')
  const size = probeVector.length

  const collections = await client.getCollections()
  const exists = collections.collections?.some(item => item.name === collection)

  if (exists) {
    const collectionInfo = await client.getCollection(collection)
    const existingSize = collectionInfo.config?.params?.vectors?.size
    if (existingSize !== undefined && existingSize !== size) {
      throw new VectorDimensionError(existingSize, size)
    }
    return { size: existingSize !== undefined ? existingSize : size }
  }

  await client.createCollection(collection, {
    vectors: { size, distance: 'Cosine' }
  })
  return { size }
}

export async function embedRecord(record, {
  client = createVectorClient(),
  collection = config.rag.collection,
  getEmbedding: embeddingFn = getEmbedding
} = {}) {
  const textBlock = recordToTextBlock(record)
  const vector = await embeddingFn(textBlock)
  await client.upsert(collection, {
    points: [{
      id: Number(record.id),
      vector,
      payload: {
        recordId: record.id,
        userId: record.user_id,
        ledgerId: record.ledger_id || null,
        date: record.date,
        month: String(record.date).slice(0, 7),
        category: record.category,
        type: record.type,
        amount: Number(record.amount_cny ?? record.amount),
        merchant: record.merchant || '',
        description: record.description || '',
        textBlock
      }
    }]
  })
}

function createMatchFilter({ userId, ledgerId, month, category, type }) {
  const must = [{ key: 'userId', match: { value: userId } }]
  if (ledgerId) must.push({ key: 'ledgerId', match: { value: ledgerId } })
  if (month) must.push({ key: 'month', match: { value: month } })
  if (category) must.push({ key: 'category', match: { value: category } })
  if (type) must.push({ key: 'type', match: { value: type } })
  return { must }
}

function mapSearchResult(item) {
  const payload = item.payload || {}
  return {
    recordId: payload.recordId,
    date: payload.date,
    category: payload.category,
    amount: Number(payload.amount || 0),
    merchant: payload.merchant || '',
    description: payload.description || '',
    score: item.score || 0
  }
}

export async function retrieveSimilar(query, {
  userId,
  ledgerId,
  month,
  category,
  type,
  limit = config.rag.topK,
  client = createVectorClient(),
  collection = config.rag.collection,
  getEmbedding: embeddingFn = getEmbedding
} = {}) {
  if (!userId || !query) return []
  try {
    const vector = await embeddingFn(query)
    const results = await client.search(collection, {
      vector,
      limit,
      with_payload: true,
      filter: createMatchFilter({ userId, ledgerId, month, category, type })
    })
    return (results || []).map(mapSearchResult)
  } catch (error) {
    console.warn('[VectorMemory] retrieve skipped:', error.message)
    return []
  }
}

export async function deleteRecordVector(recordId, {
  client = createVectorClient(),
  collection = config.rag.collection
} = {}) {
  await client.delete(collection, { points: [Number(recordId)] })
}
