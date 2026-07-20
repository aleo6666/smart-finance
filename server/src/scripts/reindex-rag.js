import { fileURLToPath } from 'node:url'
import db from '../db.js'
import * as vectorMemory from '../services/vectorMemory.js'

export function createRecordBatchRepository(dbClient, { userId = null } = {}) {
  return {
    async listBatch({ afterId = 0, batchSize = 100 } = {}) {
      const query = dbClient('records')
        .select('*')
        .where('id', '>', afterId)
        .orderBy('id', 'asc')
        .limit(batchSize)
      if (userId !== null) {
        query.where('user_id', userId)
      }
      return query
    }
  }
}

export async function rebuildRagIndex({ repository, vectorMemory: vm, batchSize = 100 }) {
  let processed = 0
  let indexed = 0
  let failed = 0
  let afterId = 0

  while (true) {
    const batch = await repository.listBatch({ afterId, batchSize })
    if (!batch || batch.length === 0) break

    for (const record of batch) {
      processed++
      try {
        await vm.embedRecord(record)
        indexed++
      } catch (error) {
        failed++
        console.warn(`[reindex] failed for record id=${record.id}: ${error.message}`)
      }
      afterId = record.id
    }

    console.log(`[reindex] progress: ${processed} processed, ${indexed} indexed, ${failed} failed`)
  }

  return { processed, indexed, failed }
}

function parseArgs(args) {
  let userId = null
  let batchSize = 100

  for (const arg of args) {
    if (arg.startsWith('--user-id=')) {
      const val = parseInt(arg.split('=')[1], 10)
      if (Number.isFinite(val) && val > 0) userId = val
    }
    if (arg.startsWith('--batch-size=')) {
      const val = parseInt(arg.split('=')[1], 10)
      if (Number.isFinite(val) && val >= 1 && val <= 500) batchSize = val
    }
  }

  return { userId, batchSize }
}

const thisFile = fileURLToPath(import.meta.url)
const isMain = process.argv[1] && (process.argv[1] === thisFile || process.argv[1].endsWith(thisFile))

if (isMain) {
  const { userId, batchSize } = parseArgs(process.argv.slice(2))
  const repository = createRecordBatchRepository(db, { userId })

  if (userId !== null) {
    console.log(`[reindex] rebuilding RAG index for user_id=${userId} (batch=${batchSize})`)
  } else {
    console.log(`[reindex] rebuilding RAG index for all records (batch=${batchSize})`)
  }

  rebuildRagIndex({ repository, vectorMemory, batchSize })
    .then(summary => {
      console.log('[reindex] complete:', JSON.stringify(summary))
      process.exit(0)
    })
    .catch(err => {
      console.error('[reindex] fatal error:', err.message)
      process.exit(1)
    })
}
