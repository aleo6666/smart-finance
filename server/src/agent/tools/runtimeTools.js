import { createDomainTools } from './domainTools.js'
import { createMemoryTools } from './memoryTools.js'
import { createAdvisorTools } from './advisorTool.js'

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
    }),
    ...createAdvisorTools({
      runtime,
      datasetStore
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
