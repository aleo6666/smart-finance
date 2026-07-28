import { createHash } from 'node:crypto'
import { createVectorClient, getEmbedding } from './vectorMemory.js'

const COLLECTION = 'knowledge_chunks_v1'
const ALLOWED_SOURCE_TYPES = new Set([
  'pdf',
  'audio_transcript',
  'long_document',
  'support_ticket'
])

export class KnowledgeVectorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'KnowledgeVectorError'
    this.code = code
  }
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function boundedText(value, max, fieldName) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > max) {
    throw new KnowledgeVectorError(
      'INVALID_FIELD',
      `${fieldName} must be 1-${max} characters`
    )
  }
  return normalized
}

function hashPointId(userId, space, docId, chunkId) {
  const digest = createHash('sha256')
    .update(`${userId}:${space}:${docId}:${chunkId}`)
    .digest('hex')
    .slice(0, 16)
  return parseInt(digest, 16) % 9007199254740991
}

export async function initKnowledgeCollection({
  client = createVectorClient(),
  embeddingClient
} = {}) {
  const collections = await client.getCollections()
  const exists = (collections.collections ?? []).some(
    item => item.name === COLLECTION
  )
  if (exists) return { collection: COLLECTION }

  let size = 1536
  if (typeof embeddingClient?.embed === 'function') {
    try {
      const probe = await embeddingClient.embed('knowledge probe')
      size = probe.length
    } catch {
      // fall back to default dimension
    }
  }

  await client.createCollection(COLLECTION, {
    vectors: { size, distance: 'Cosine' }
  })
  return { collection: COLLECTION, size }
}

export async function indexKnowledgeChunk({
  userId,
  knowledgeSpaceId,
  documentId,
  chunkId,
  sourceType,
  title,
  text,
  client = createVectorClient(),
  getEmbeddingFn = getEmbedding
}) {
  const trustedUserId = positiveInteger(userId, 'userId')
  const trustedSpace = boundedText(knowledgeSpaceId, 64, 'knowledgeSpaceId')
  const trustedDocId = boundedText(documentId, 128, 'documentId')
  const trustedChunkId = boundedText(chunkId, 128, 'chunkId')

  if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
    throw new KnowledgeVectorError(
      'INVALID_SOURCE_TYPE',
      `sourceType must be one of: ${[...ALLOWED_SOURCE_TYPES].join(', ')}`
    )
  }

  const cleanTitle = boundedText(title, 256, 'title')
  const cleanText = boundedText(text, 8000, 'text')

  const payload = {
    userId: trustedUserId,
    knowledgeSpaceId: trustedSpace,
    documentId: trustedDocId,
    chunkId: trustedChunkId,
    sourceType,
    title: cleanTitle,
    createdAt: new Date().toISOString()
  }

  const vector = await getEmbeddingFn(cleanText)
  const pointId = hashPointId(trustedUserId, trustedSpace, trustedDocId, trustedChunkId)

  await client.upsert(COLLECTION, {
    points: [{
      id: pointId,
      vector,
      payload: { ...payload, text: cleanText }
    }]
  })

  return { pointId, payload }
}

export async function searchKnowledge({
  userId,
  knowledgeSpaceId,
  query,
  limit = 5,
  client = createVectorClient(),
  getEmbeddingFn = getEmbedding
}) {
  const trustedUserId = positiveInteger(userId, 'userId')
  const trustedSpace = boundedText(knowledgeSpaceId, 64, 'knowledgeSpaceId')

  const filter = {
    must: [
      { key: 'userId', match: { value: trustedUserId } },
      { key: 'knowledgeSpaceId', match: { value: trustedSpace } }
    ]
  }

  const vector = await getEmbeddingFn(query)
  const results = await client.search(COLLECTION, {
    vector,
    limit: positiveInteger(limit, 'limit'),
    with_payload: true,
    filter
  })

  return (results ?? []).map(item => {
    const p = item.payload ?? {}
    return {
      documentId: p.documentId,
      chunkId: p.chunkId,
      sourceType: p.sourceType,
      title: p.title,
      text: p.text,
      score: item.score ?? 0
    }
  })
}
