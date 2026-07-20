import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('index registers health, insights and datasets api routes', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')

  assert.match(source, /createHealthRouter/)
  assert.match(source, /app\.use\('\/api\/health'/)
  assert.match(source, /import insightsRouter from '\.\/routes\/insights\.js'/)
  assert.match(source, /import datasetsRouter from '\.\/routes\/datasets\.js'/)
  assert.match(source, /app\.use\('\/api\/insights', insightsRouter\)/)
  assert.match(source, /app\.use\('\/api\/datasets', datasetsRouter\)/)
})
