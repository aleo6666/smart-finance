import { createHash } from 'crypto'
import { QdrantClient } from '@qdrant/js-client-rest'
import config from '../config.js'

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

export async function getEmbedding(text, { fetchImpl = fetch } = {}) {
  if (!config.ai.openaiApiKey) return createDeterministicEmbedding(text)

  const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.ai.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.ai.embeddingModel,
      input: text
    })
  })

  if (!response.ok) {
    throw new Error(`OpenAI embedding failed: ${response.status}`)
  }

  const json = await response.json()
  return json.data?.[0]?.embedding || createDeterministicEmbedding(text)
}

export async function initVectorCollection({
  client = createVectorClient(),
  collection = config.vector.collection,
  size = 1536
} = {}) {
  const collections = await client.getCollections()
  const exists = collections.collections?.some(item => item.name === collection)
  if (!exists) {
    await client.createCollection(collection, {
      vectors: { size, distance: 'Cosine' }
    })
  }
}

export async function embedRecord(record, {
  client = createVectorClient(),
  collection = config.vector.collection,
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

export async function retrieveSimilar() {
  return []
}
