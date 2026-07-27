import { tool } from 'langchain'
import { z } from 'zod'
import { searchKnowledge } from '../../services/knowledgeVector.js'

export function createKnowledgeTool({ runtime, search = searchKnowledge }) {
  return tool(
    async ({ query, knowledgeSpaceId }) => {
      try {
        const results = await search({
          userId: runtime.userId,
          knowledgeSpaceId,
          query,
          limit: 5
        })
        return {
          status: 'ok',
          count: results.length,
          results: results.map(r => ({
            title: r.title,
            sourceType: r.sourceType,
            text: r.text
          }))
        }
      } catch (error) {
        return {
          status: 'unavailable',
          count: 0,
          results: [],
          reason: 'KNOWLEDGE_SEARCH_FAILED'
        }
      }
    },
    {
      name: 'search_knowledge_base',
      description:
        '搜索当前用户拥有的非结构化知识库（PDF、长文档、对话录音转写等）。只能检索已上传的知识，不包含账单、预算或金额数据。',
      schema: z.object({
        query: z.string().min(1).max(512).describe('知识库搜索查询，自然语言'),
        knowledgeSpaceId: z
          .enum(['personal', 'family', 'work'])
          .describe('知识空间标识')
      })
    }
  )
}
