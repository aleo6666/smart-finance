import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('index registers health, insights, datasets and email auth api routes', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')

  assert.match(source, /createHealthRouter/)
  assert.match(source, /app\.use\('\/api\/health'/)
  assert.match(source, /import insightsRouter from '\.\/routes\/insights\.js'/)
  assert.match(source, /import datasetsRouter from '\.\/routes\/datasets\.js'/)
  assert.match(source, /app\.use\('\/api\/insights', insightsRouter\)/)
  assert.match(source, /app\.use\('\/api\/datasets', datasetsRouter\)/)
  assert.match(source, /import \{ createDefaultEmailAuthRouter \} from '\.\/routes\/emailAuth\.js'/)
  assert.match(source, /app\.use\('\/api\/auth\/email', createDefaultEmailAuthRouter\(\)\)/)
  assert.ok(
    source.indexOf("app.use('/api/auth', authLimiter)") <
      source.indexOf("app.use('/api/auth/email', createDefaultEmailAuthRouter())")
  )
})

test('current-user query includes verified email identity fields', async () => {
  const source = await readFile(new URL('../src/routes/auth.js', import.meta.url), 'utf8')
  const meRoute = source.slice(source.indexOf("router.get('/me'"), source.indexOf("router.get('/wechat-mp'"))

  assert.match(meRoute, /\.select\([^)]*'email'[^)]*'email_verified_at'[^)]*\)/s)
})
