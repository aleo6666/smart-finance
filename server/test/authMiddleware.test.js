import test from 'node:test'
import assert from 'node:assert/strict'

test('auth middleware requires JWT_SECRET in production', async () => {
  const oldNodeEnv = process.env.NODE_ENV
  const oldJwtSecret = process.env.JWT_SECRET
  process.env.NODE_ENV = 'production'
  delete process.env.JWT_SECRET

  try {
    await assert.rejects(
      import(`../src/middleware/auth.js?production-secret-check=${Date.now()}`),
      /JWT_SECRET is required in production/
    )
  } finally {
    if (oldNodeEnv == null) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldNodeEnv
    if (oldJwtSecret == null) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = oldJwtSecret
  }
})

test('auth middleware rejects default-like JWT_SECRET in production', async () => {
  const oldNodeEnv = process.env.NODE_ENV
  const oldJwtSecret = process.env.JWT_SECRET
  process.env.NODE_ENV = 'production'
  process.env.JWT_SECRET = 'change-me-to-random-64-char-string-xxxxxxxxxxxxxxxx'

  try {
    await assert.rejects(
      import(`../src/middleware/auth.js?production-default-secret-check=${Date.now()}`),
      /JWT_SECRET must be changed in production/
    )
  } finally {
    if (oldNodeEnv == null) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldNodeEnv
    if (oldJwtSecret == null) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = oldJwtSecret
  }
})
