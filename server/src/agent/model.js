import { ChatOpenAI } from '@langchain/openai'

function requiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${fieldName} is required`)
  }
  return value.trim()
}

function publicApiUrl(value) {
  const normalized = requiredString(value, 'baseUrl')
  let url
  try {
    url = new URL(normalized)
  } catch {
    throw new TypeError('baseUrl must be an HTTP API URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('baseUrl must be an HTTP API URL')
  }
  return normalized.replace(/\/+$/, '')
}

export function createFinanceModel({
  baseUrl,
  apiKey,
  model,
  maxRetries,
  timeout
}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('maxRetries must be a non-negative integer')
  }
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new TypeError('timeout must be a positive integer')
  }

  return new ChatOpenAI({
    model: requiredString(model, 'model'),
    temperature: 0.1,
    apiKey: requiredString(apiKey, 'apiKey'),
    maxRetries,
    timeout,
    configuration: {
      baseURL: publicApiUrl(baseUrl)
    }
  })
}
