import { createVectorClient } from '../services/vectorMemory.js'

const ALLOWED_LEGACY_COLLECTIONS = new Set([
  'finance_records',
  'finance_records_nomic_v1'
])

function exitError(message) {
  console.error(message)
  process.exit(1)
}

async function main() {
  const target = process.argv[2]
  const confirm = process.argv[3]

  if (!target || !ALLOWED_LEGACY_COLLECTIONS.has(target)) {
    exitError(
      `Usage: npm run vectors:delete-legacy -- <collection> --confirm-delete\n` +
      `  Allowed collections: ${[...ALLOWED_LEGACY_COLLECTIONS].join(', ')}`
    )
  }

  if (confirm !== '--confirm-delete') {
    exitError(
      'Must pass --confirm-delete to proceed.\n' +
      `Are you sure you want to delete "${target}"? If so, re-run with --confirm-delete`
    )
  }

  const client = createVectorClient()

  try {
    const collections = await client.getCollections()
    const exists = (collections.collections ?? []).some(
      item => item.name === target
    )
    if (!exists) {
      console.log(`Collection "${target}" does not exist — nothing to delete.`)
      return
    }

    await client.deleteCollection(target)
    console.log(`Collection "${target}" deleted.`)
  } catch (error) {
    console.error(`Failed to delete "${target}": ${error.message}`)
    process.exit(1)
  }
}

main()
