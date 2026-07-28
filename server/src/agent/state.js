import { MessagesValue, StateSchema } from '@langchain/langgraph'
import { z } from 'zod'

export const INTENT_PARTS = Object.freeze([
  'record',
  'query',
  'stat',
  'analysis',
  'suggest',
  'ocr',
  'chat',
  'unknown'
])

const INTENT_PART_SET = new Set(INTENT_PARTS)

export const IntentTypeSchema = z.string().refine(value => {
  const parts = value.split('+')
  return parts.length > 0 &&
    parts.every(part => INTENT_PART_SET.has(part)) &&
    new Set(parts).size === parts.length
}, 'invalid intent type')

const objectMap = () => z.record(z.string(), z.unknown())
const objectArray = () => z.array(objectMap())

export const AgentState = new StateSchema({
  messages: MessagesValue,
  userId: z.number().int().positive(),
  sessionId: z.string().min(1).max(128),
  sessionMetadata: objectMap().default(() => ({})),
  userMemory: objectArray().default(() => []),
  recentSummary: objectMap().default(() => ({})),
  datasetRefs: objectArray().default(() => []),
  pendingConfirmation: objectMap().nullable().default(null),
  toolCallCount: z.number().int().nonnegative().default(0),
  errors: objectArray().default(() => []),
  response: objectMap().nullable().default(null),
  requestStartTime: z.number().int().nonnegative(),
  isAdmin: z.boolean().default(false),
  intentType: IntentTypeSchema.default('unknown')
})
