import { createDomainTools } from './domainTools.js'
import { createMemoryTools } from './memoryTools.js'

export function createRuntimeTools({
  runtime,
  datasetStore,
  operationStore,
  memoryRepository
}) {
  const tools = [
    ...createDomainTools({
      runtime,
      datasetStore,
      operationStore
    })
  ]

  if (memoryRepository) {
    tools.push(...createMemoryTools({
      runtime,
      repository: memoryRepository
    }))
  }

  return tools
}
