import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))

function importAuthInProduction(jwtSecret) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./src/middleware/auth.js')"],
    {
      cwd: serverDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: jwtSecret,
        DB_PASSWORD: 'strong-test-only-database-password'
      }
    }
  )
}

test('auth middleware requires JWT_SECRET in production', () => {
  const result = importAuthInProduction('')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /JWT_SECRET is required in production/)
})

test('auth middleware rejects default-like JWT_SECRET in production', () => {
  const result = importAuthInProduction('change-me-to-random-64-char-string-xxxxxxxxxxxxxxxx')

  assert.equal(result.status, 1)
  assert.match(result.stderr, /JWT_SECRET must be changed in production/)
})
