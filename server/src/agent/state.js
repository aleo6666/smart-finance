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

const FINANCE_INTENT_PARTS = INTENT_PARTS.slice(0, 6)
const INTENT_ORDER = new Map(INTENT_PARTS.map((part, index) => [part, index]))

export const IntentTypeSchema = z.string().refine(value => {
  const parts = value.split('+')
  if (parts.some(part => !INTENT_ORDER.has(part))) return false
  if (new Set(parts).size !== parts.length) return false

  if (parts.includes('chat') || parts.includes('unknown')) {
    return parts.length === 1
  }

  return parts.length > 0 &&
    parts.every(part => FINANCE_INTENT_PARTS.includes(part)) &&
    parts.every((part, index) => index === 0 || INTENT_ORDER.get(parts[index - 1]) < INTENT_ORDER.get(part))
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
