import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')

const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf-8')
const dockerfile = readFileSync(join(root, 'server', 'Dockerfile'), 'utf-8')
const serverPackage = JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf-8'))
const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8')
const envExample = existsSync(join(root, '.env.example'))
  ? readFileSync(join(root, '.env.example'), 'utf-8')
  : ''
const startScript = existsSync(join(root, 'scripts', 'start-local.ps1'))
  ? readFileSync(join(root, 'scripts', 'start-local.ps1'), 'utf-8')
  : ''
const stopScript = existsSync(join(root, 'scripts', 'stop-local.ps1'))
  ? readFileSync(join(root, 'scripts', 'stop-local.ps1'), 'utf-8')
  : ''

test('docker-compose passes LM Studio and RAG vars to backend', () => {
  assert.match(compose, /LM_STUDIO_BASE_URL/)
  assert.match(compose, /RAG_COLLECTION/)
  assert.match(compose, /RAG_ENABLED/)
})

test('docker-compose has host.docker.internal for LM Studio access', () => {
  assert.match(compose, /host\.docker\.internal/)
})

test('docker-compose does not mount finance.db', () => {
  assert.ok(!compose.includes('finance.db'), 'finance.db volume should be removed')
})

test('server Dockerfile uses Node 22', () => {
  assert.match(dockerfile, /^FROM node:22-alpine$/m)
})

test('server package metadata requires Node 22', () => {
  assert.equal(serverPackage.engines?.node, '>=22')
})

test('.gitignore includes .env.local', () => {
  assert.match(gitignore, /^\.env\.local$/m)
})

test('.env.example has no real secrets', () => {
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(envExample), 'no OpenAI keys in .env.example')
  assert.ok(!/JWT_SECRET=[^\s]{8,}/.test(envExample), 'no real JWT secret in .env.example')
})

test('start-local.ps1 references lms server start', () => {
  assert.match(startScript, /lms server start/)
})

test('stop-local.ps1 references lms server start with 127.0.0.1', () => {
  assert.match(stopScript, /lms server start.*127\.0\.0\.1/)
})
