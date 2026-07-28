import { tool } from 'langchain'
import { z } from 'zod'

const namespaceSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const memoryKeySchema = z.string().regex(/^[a-z0-9_]{1,64}$/)
const valueSchema = z.record(z.string(), z.unknown())
const expectedVersionSchema = z.number().int().positive()

function publicMemoryResult(memory) {
  if (!memory) return null
  return {
    namespace: memory.namespace,
    memoryKey: memory.memoryKey,
    sensitivity: memory.sensitivity,
    status: memory.status,
    version: memory.version,
    expiresAt: memory.expiresAt ?? null
  }
}

export function createMemoryTools({ repository, runtime }) {
  const trusted = () => ({
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    operationId: runtime.operationId
  })

  return [
    tool(async input => publicMemoryResult(await repository.get(
      runtime.userId,
      input.namespace,
      input.memoryKey
    )), {
      name: 'get_user_memory',
      description: '读取一条精确键位的用户记忆元数据',
      schema: z.object({
        namespace: namespaceSchema,
        memoryKey: memoryKeySchema
      })
    }),
    tool(async input => publicMemoryResult(await repository.propose({
      ...input,
      ...trusted()
    })), {
      name: 'propose_user_memory',
      description: '提议保存用户明确表达的稳定事实；敏感事实只进入待确认状态',
      schema: z.object({
        namespace: namespaceSchema,
        memoryKey: memoryKeySchema,
        value: valueSchema
      })
    }),
    tool(async input => publicMemoryResult(await repository.update({
      ...input,
      ...trusted()
    })), {
      name: 'update_user_memory',
      description: '按精确键和版本更新用户记忆；敏感更新需要再次确认',
      schema: z.object({
        namespace: namespaceSchema,
        memoryKey: memoryKeySchema,
        value: valueSchema,
        expectedVersion: expectedVersionSchema
      })
    }),
    tool(async input => publicMemoryResult(await repository.confirm({
      ...input,
      ...trusted()
    })), {
      name: 'confirm_user_memory',
      description: '显式确认一条待确认的敏感用户记忆',
      schema: z.object({
        namespace: namespaceSchema,
        memoryKey: memoryKeySchema,
        expectedVersion: expectedVersionSchema
      })
    }),
    tool(async input => publicMemoryResult(await repository.softDelete({
      ...input,
      ...trusted()
    })), {
      name: 'delete_user_memory',
      description: '按精确键和版本软删除用户记忆',
      schema: z.object({
        namespace: namespaceSchema,
        memoryKey: memoryKeySchema,
        expectedVersion: expectedVersionSchema
      })
    })
  ]
}
