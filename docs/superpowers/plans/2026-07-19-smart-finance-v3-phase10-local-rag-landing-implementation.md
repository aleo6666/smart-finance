# Smart Finance V3 Phase 10 Local RAG Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a one-command Windows local deployment whose Node backend uses LM Studio for real embeddings and Qwen answers, Qdrant for user-scoped retrieval, and MySQL for authoritative finance totals.

**Architecture:** Docker Compose runs the web client, Node backend, MySQL, Redis, and Qdrant; LM Studio stays on the Windows host and exposes its OpenAI-compatible API to the backend through `host.docker.internal`. Exact finance queries remain SQL-backed, while advice and semantic questions use a bounded RAG service that returns auditable record sources and degrades safely.

**Tech Stack:** Node.js 22, Express 4, Node Test Runner, Knex/MySQL 8.4, Redis 7, Qdrant, LM Studio OpenAI-compatible API, Vue 3/Vite, Docker Compose, PowerShell 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/config.js` | LM Studio and RAG environment configuration |
| `server/src/services/lmStudioClient.js` | OpenAI-compatible model discovery, embedding, and chat calls |
| `server/src/services/vectorMemory.js` | Versioned Qdrant collection, record upsert/delete, scoped search |
| `server/src/services/ragService.js` | Context bounding, prompt construction, Qwen answer, fallback |
| `server/src/services/healthService.js` | Dependency-specific health checks |
| `server/src/services/recorderAgent.js` | Best-effort vector indexing after authoritative DB write |
| `server/src/routes/records.js` | Keep vectors synchronized on create/update/delete |
| `server/src/routes/chat.js` | SQL-first query routing and RAG integration |
| `server/src/routes/health.js` | Detailed local readiness endpoint |
| `server/src/scripts/reindex-rag.js` | Idempotent MySQL-to-Qdrant rebuild |
| `server/src/scripts/smoke-local.js` | Real API smoke with cleanup |
| `scripts/start-local.ps1` | Preflight, LM Studio binding, Compose startup, readiness, smoke |
| `scripts/stop-local.ps1` | Compose stop and LM Studio localhost restoration |
| `.env.example` / `.gitignore` | Safe local configuration contract |
| `docker-compose.yml` | Complete local container topology |
| `README.md` | Local start, stop, troubleshooting, and RAG behavior |

## Task 1: LM Studio and RAG Configuration Client

**Files:**
- Modify: `server/src/config.js`
- Create: `server/src/services/lmStudioClient.js`
- Modify: `server/test/config.test.js`
- Create: `server/test/lmStudioClient.test.js`

- [ ] **Step 1: Write failing configuration tests**

Add to `server/test/config.test.js`:

```js
test('loadConfig returns local LM Studio and RAG defaults', () => {
  const loaded = loadConfig({})
  assert.deepEqual(loaded.lmStudio, {
    baseUrl: 'http://127.0.0.1:1234/v1',
    chatModel: 'qwen3.6-35b-a3b',
    embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
    embeddingTimeoutMs: 10000,
    chatTimeoutMs: 120000
  })
  assert.deepEqual(loaded.rag, {
    enabled: true,
    collection: 'finance_records_nomic_v1',
    topK: 5,
    maxContextChars: 6000
  })
})

test('loadConfig reads LM Studio and bounded RAG overrides', () => {
  const loaded = loadConfig({
    LM_STUDIO_BASE_URL: 'http://host.docker.internal:1234/v1/',
    LM_STUDIO_CHAT_MODEL: 'local-chat',
    LM_STUDIO_EMBEDDING_MODEL: 'local-embed',
    RAG_ENABLED: 'false',
    RAG_TOP_K: '99',
    RAG_MAX_CONTEXT_CHARS: '999999'
  })
  assert.equal(loaded.lmStudio.baseUrl, 'http://host.docker.internal:1234/v1')
  assert.equal(loaded.rag.enabled, false)
  assert.equal(loaded.rag.topK, 20)
  assert.equal(loaded.rag.maxContextChars, 20000)
})
```

- [ ] **Step 2: Write failing LM Studio client tests**

Create `server/test/lmStudioClient.test.js` with tests that inject `fetchFn` and assert:

```js
test('embed calls the configured OpenAI-compatible endpoint', async () => {
  const calls = []
  const client = createLmStudioClient({
    settings: { baseUrl: 'http://lm/v1', embeddingModel: 'embed-model', chatModel: 'chat-model', embeddingTimeoutMs: 100, chatTimeoutMs: 100 },
    fetchFn: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return response({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    }
  })
  assert.deepEqual(await client.embed('午餐消费'), [0.1, 0.2, 0.3])
  assert.equal(calls[0].url, 'http://lm/v1/embeddings')
  assert.deepEqual(calls[0].body, { model: 'embed-model', input: '午餐消费' })
})

test('chat returns content and rejects malformed responses safely', async () => {
  const good = createLmStudioClient({
    settings: { baseUrl: 'http://lm/v1', embeddingModel: 'embed', chatModel: 'chat', embeddingTimeoutMs: 100, chatTimeoutMs: 100 },
    fetchFn: async () => response({ choices: [{ message: { content: '建议减少外卖。' } }] })
  })
  assert.equal(await good.chat([{ role: 'user', content: '给我建议' }]), '建议减少外卖。')

  const bad = createLmStudioClient({
    settings: { baseUrl: 'http://lm/v1', embeddingModel: 'embed', chatModel: 'chat', embeddingTimeoutMs: 100, chatTimeoutMs: 100 },
    fetchFn: async () => response({ choices: [] })
  })
  await assert.rejects(bad.chat([]), /LM Studio 返回格式无效/)
})
```

Also cover `listModels()` and an aborted timeout returning `LmStudioError` without response bodies or prompt content in its message.

- [ ] **Step 3: Run RED**

Run:

```powershell
cd server
npm test -- test/config.test.js test/lmStudioClient.test.js
```

Expected: FAIL because `config.lmStudio`, `config.rag`, and `lmStudioClient.js` do not exist.

- [ ] **Step 4: Implement bounded configuration**

Add helpers to `config.js`:

```js
function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '')
}
```

Add `lmStudio` and `rag` objects using the exact defaults from Step 1. Bound Top-K to `1..20`, context to `1000..20000`, embedding timeout to `1000..60000`, and chat timeout to `5000..300000`.

- [ ] **Step 5: Implement the injectable LM Studio client**

Implement `createLmStudioClient({ settings = config.lmStudio, fetchFn = fetch } = {})` with:

```js
export class LmStudioError extends Error {
  constructor(message, { status = 502, code = 'LM_STUDIO_ERROR' } = {}) {
    super(message)
    this.name = 'LmStudioError'
    this.status = status
    this.code = code
  }
}
```

Use `AbortController` per request. Expose `listModels()`, `embed(text)`, and `chat(messages)`. Validate non-empty model IDs, non-empty numeric embedding arrays, and non-empty chat content. Export a default configured client.

- [ ] **Step 6: Run GREEN and full regression**

```powershell
cd server
npm test -- test/config.test.js test/lmStudioClient.test.js
npm test
```

Expected: targeted tests and the entire backend suite pass.

- [ ] **Step 7: Commit only Task 1 files**

```powershell
git add server/src/config.js server/src/services/lmStudioClient.js server/test/config.test.js server/test/lmStudioClient.test.js
git commit -m "feat: add local lm studio client"
```

## Task 2: Real Embeddings and Versioned Qdrant Collection

**Files:**
- Modify: `server/src/services/vectorMemory.js`
- Modify: `server/test/vectorMemory.test.js`

- [ ] **Step 1: Replace hash-fallback tests with real-client contract tests**

Update tests to inject `lmStudioClient: { embed: async () => [0.1, 0.2] }` and verify:

```js
test('initVectorCollection probes embedding size and creates versioned collection', async () => {
  const calls = []
  const client = {
    getCollections: async () => ({ collections: [] }),
    createCollection: async (name, body) => calls.push({ name, body })
  }
  const result = await initVectorCollection({
    client,
    collection: 'finance_records_nomic_v1',
    embeddingClient: { embed: async text => { assert.equal(text, '维度探针'); return [0.1, 0.2, 0.3] } }
  })
  assert.equal(result.size, 3)
  assert.deepEqual(calls[0], {
    name: 'finance_records_nomic_v1',
    body: { vectors: { size: 3, distance: 'Cosine' } }
  })
})
```

Add tests for an existing collection with matching size, a dimension mismatch raising `VectorDimensionError`, `ledgerId` in the Qdrant filter, and `deleteRecordVector(recordId)`.

- [ ] **Step 2: Run RED**

```powershell
cd server
npm test -- test/vectorMemory.test.js
```

Expected: FAIL because vector initialization is fixed at 1536, runtime hashing remains, and delete/ledger filtering are missing.

- [ ] **Step 3: Implement true LM Studio embeddings**

Remove runtime use of `createDeterministicEmbedding`. Keep deterministic vectors only inside tests. Make `getEmbedding(text, { embeddingClient = defaultLmStudioClient } = {})` delegate to `embeddingClient.embed(text)`.

Add:

```js
export class VectorDimensionError extends Error {
  constructor(expected, actual) {
    super(`向量集合维度不匹配：集合=${expected}，模型=${actual}`)
    this.name = 'VectorDimensionError'
  }
}
```

Probe with `embeddingClient.embed('维度探针')`. For an existing collection call `getCollection(collection)` and read its vector size; never delete an incompatible collection automatically.

- [ ] **Step 4: Add scoped upsert, search, and delete**

Extend `createMatchFilter({ userId, ledgerId, month, category, type })`. Reject retrieval without `userId`. Add:

```js
export async function deleteRecordVector(recordId, {
  client = createVectorClient(),
  collection = config.rag.collection
} = {}) {
  await client.delete(collection, { points: [Number(recordId)] })
}
```

Use `config.rag.collection` and `config.rag.topK` everywhere.

- [ ] **Step 5: Run GREEN and regression**

```powershell
cd server
npm test -- test/vectorMemory.test.js
npm test
```

- [ ] **Step 6: Commit**

```powershell
git add server/src/services/vectorMemory.js server/test/vectorMemory.test.js
git commit -m "feat: use lm studio embeddings in qdrant"
```

## Task 3: Best-Effort Index Consistency and Rebuild

**Files:**
- Modify: `server/src/services/recorderAgent.js`
- Modify: `server/src/routes/records.js`
- Create: `server/src/scripts/reindex-rag.js`
- Modify: `server/package.json`
- Modify: `server/test/agentFlow.test.js`
- Create: `server/test/recordsVectorSync.test.js`
- Create: `server/test/reindexRag.test.js`

- [ ] **Step 1: Write failing best-effort and CRUD synchronization tests**

Add an `agentFlow` test where `embedRecord()` throws but `recordFromPlannerTask()` still returns the inserted record ID and records a succeeded agent event with `vectorIndexed: false`.

Create an injectable vector dependency in `createRecordsRouter` and test:

```js
vectorMemory: {
  embedRecord: async record => indexed.push(record),
  deleteRecordVector: async id => deleted.push(Number(id))
}
```

Assert POST indexes after DB insert, PUT re-fetches and re-indexes the updated row, DELETE removes the corresponding vector, and all three API operations still succeed when the vector operation throws.

- [ ] **Step 2: Write failing rebuild tests**

Define and test:

```js
const result = await rebuildRagIndex({
  repository: { listBatch: async ({ afterId }) => afterId ? [] : [{ id: 1, user_id: 7 }] },
  vectorMemory: { embedRecord: async record => indexed.push(record) },
  batchSize: 100
})
assert.deepEqual(result, { processed: 1, indexed: 1, failed: 0 })
```

Also test one failed record increments `failed` and does not stop the batch.

- [ ] **Step 3: Run RED**

```powershell
cd server
npm test -- test/agentFlow.test.js test/recordsVectorSync.test.js test/reindexRag.test.js
```

- [ ] **Step 4: Implement best-effort synchronization**

Wrap vector work independently from DB and budget-monitor work. Return indexing status in service results, log only record IDs and safe error messages, and inject `vectorMemory` into the records router.

- [ ] **Step 5: Implement rebuild command**

Export `createRecordBatchRepository(dbClient)`, `rebuildRagIndex(...)`, and a CLI main guarded by an `import.meta.url` comparison. Add package script:

```json
"reindex:rag": "node src/scripts/reindex-rag.js"
```

Support `--user-id=<positive integer>` and `--batch-size=<1..500>` arguments. Iterate by ascending record ID, not offset.

- [ ] **Step 6: Run GREEN and regression**

```powershell
cd server
npm test -- test/agentFlow.test.js test/recordsVectorSync.test.js test/reindexRag.test.js
npm test
```

- [ ] **Step 7: Commit**

```powershell
git add server/src/services/recorderAgent.js server/src/routes/records.js server/src/scripts/reindex-rag.js server/package.json server/test/agentFlow.test.js server/test/recordsVectorSync.test.js server/test/reindexRag.test.js
git commit -m "feat: keep rag index rebuildable"
```

## Task 4: Evidence-Grounded RAG Answers

**Files:**
- Create: `server/src/services/ragService.js`
- Create: `server/test/ragService.test.js`
- Modify: `server/src/routes/chat.js`
- Modify: `server/test/chatRoute.test.js`

- [ ] **Step 1: Write failing RAG service tests**

Use injected retrieval and chat dependencies:

```js
test('answer returns grounded Qwen response and record sources', async () => {
  const service = createRagService({
    retrieveSimilar: async () => [
      { recordId: 12, date: '2026-07-18', category: '餐饮', amount: 88, merchant: '食堂', description: '午餐', score: 0.91 }
    ],
    lmStudioClient: {
      chat: async messages => {
        assert.match(messages[0].content, /不得编造/)
        assert.match(messages[1].content, /记录ID: 12/)
        return '根据相关记录，建议先控制餐饮频率。'
      }
    },
    settings: { enabled: true, topK: 5, maxContextChars: 6000 }
  })
  const result = await service.answer({ question: '怎么减少日常开销？', userId: 7, hints: {} })
  assert.equal(result.message, '根据相关记录，建议先控制餐饮频率。')
  assert.deepEqual(result.sources, [12])
  assert.equal(result.records, 1)
})
```

Test user ID forwarding, context truncation, no-record fallback, disabled RAG, and LM Studio failure fallback. Fallback must use `buildMemoryReply` when records exist and the original base message otherwise.

- [ ] **Step 2: Write failing chat route tests**

Inject `ragService` into `createChatRouter`. Assert:

- A finance `query` with a SQL summary never calls RAG.
- `advice` for an authenticated user calls RAG and exposes `data.rag = { records, sources }`.
- Anonymous requests never call RAG.
- RAG failure leaves a successful bounded fallback response.

- [ ] **Step 3: Run RED**

```powershell
cd server
npm test -- test/ragService.test.js test/chatRoute.test.js
```

- [ ] **Step 4: Implement `createRagService`**

Expose `answer({ question, userId, hints, baseMessage })`. Build exactly two messages: a fixed system safety prompt and a user message containing the question plus numbered evidence rows. Limit serialized evidence to `maxContextChars` before calling chat. Return unique numeric source IDs.

- [ ] **Step 5: Integrate SQL-first routing**

Keep exact `queryFinanceSummary` ahead of RAG. Call RAG only when no exact SQL summary exists and the user is authenticated. Replace the current 300ms vector timeout with timeouts owned by the LM Studio client; retain short Redis context timeouts.

- [ ] **Step 6: Run GREEN and full regression**

```powershell
cd server
npm test -- test/ragService.test.js test/chatRoute.test.js
npm test
```

- [ ] **Step 7: Commit**

```powershell
git add server/src/services/ragService.js server/src/routes/chat.js server/test/ragService.test.js server/test/chatRoute.test.js
git commit -m "feat: answer advice with grounded local rag"
```

## Task 5: Dependency Readiness and Safe Diagnostics

**Files:**
- Create: `server/src/services/healthService.js`
- Create: `server/src/routes/health.js`
- Create: `server/test/healthService.test.js`
- Create: `server/test/healthRoute.test.js`
- Modify: `server/src/index.js`
- Modify: `server/test/indexRouteRegistration.test.js`

- [ ] **Step 1: Write failing health tests**

Test `checkDependencies()` with injected checks returning:

```js
{
  status: 'ready',
  services: {
    mysql: { ok: true },
    redis: { ok: true },
    qdrant: { ok: true },
    lmStudioModels: { ok: true },
    lmStudioEmbedding: { ok: true, dimensions: 768 },
    lmStudioChat: { ok: true }
  }
}
```

One failed dependency must return `status: 'degraded'`, a safe short reason, and no stack, prompt, database password, or response body.

Route tests must assert `GET /api/health` stays a cheap liveness response and `GET /api/health/ready` returns 200 for ready, 503 for degraded.

- [ ] **Step 2: Run RED**

```powershell
cd server
npm test -- test/healthService.test.js test/healthRoute.test.js test/indexRouteRegistration.test.js
```

- [ ] **Step 3: Implement dependency checks**

Use `db.raw('SELECT 1')`, Redis `ping`, Qdrant `getCollections`, LM Studio `listModels`, one short probe embedding, and a minimal chat prompt that must return non-empty text. Keep dependency injection for tests.

- [ ] **Step 4: Register health router**

Move the existing health response into `routes/health.js`, mount it at `/api/health`, and update the registration test.

- [ ] **Step 5: Run GREEN and regression**

```powershell
cd server
npm test -- test/healthService.test.js test/healthRoute.test.js test/indexRouteRegistration.test.js
npm test
```

- [ ] **Step 6: Commit**

```powershell
git add server/src/services/healthService.js server/src/routes/health.js server/src/index.js server/test/healthService.test.js server/test/healthRoute.test.js server/test/indexRouteRegistration.test.js
git commit -m "feat: add local dependency readiness checks"
```

## Task 6: Docker and PowerShell One-Command Startup

**Files:**
- Modify: `.gitignore`
- Create: `.env.example`
- Modify: `docker-compose.yml`
- Create: `scripts/start-local.ps1`
- Create: `scripts/stop-local.ps1`
- Create: `server/test/localDeploymentConfig.test.js`

- [ ] **Step 1: Write failing deployment configuration tests**

Read files as text and assert:

```js
assert.match(compose, /LM_STUDIO_BASE_URL: \$\{LM_STUDIO_BASE_URL:-http:\/\/host\.docker\.internal:1234\/v1\}/)
assert.match(compose, /RAG_COLLECTION: \$\{RAG_COLLECTION:-finance_records_nomic_v1\}/)
assert.match(compose, /extra_hosts:[\s\S]*host\.docker\.internal:host-gateway/)
assert.match(gitignore, /^\.env\.local$/m)
assert.match(startScript, /lms server start --port 1234 --bind 0\.0\.0\.0/)
assert.match(stopScript, /lms server start --port 1234 --bind 127\.0\.0\.1/)
```

Also assert the Compose backend no longer mounts `server/finance.db` and `.env.example` contains no `sk-` secret.

- [ ] **Step 2: Run RED**

```powershell
cd server
npm test -- test/localDeploymentConfig.test.js
```

- [ ] **Step 3: Add safe local environment contract**

Add `.env.local` to `.gitignore`. Create `.env.example` with database defaults, blank JWT, LM Studio host URL, the two exact model IDs, RAG defaults, and no real secret.

- [ ] **Step 4: Update Compose**

Pass LM Studio/RAG variables to the backend, add `extra_hosts`, remove the SQLite volume, add a Qdrant health check, and make backend readiness depend on healthy infrastructure. Keep frontend port 80 and backend port 3000.

- [ ] **Step 5: Implement `start-local.ps1`**

The script must use `$ErrorActionPreference = 'Stop'` and concrete helpers `Assert-Command`, `Wait-Http`, and `New-LocalEnv`. Generate JWT with:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$jwt = [Convert]::ToBase64String($bytes)
```

Use `lms ls`, `lms server stop`, and `lms server start --port 1234 --bind 0.0.0.0`. Never pass `--cors`. Run Compose with `--env-file .env.local`, wait for `/api/health`, then `/api/health/ready`, and finally run the smoke script inside the backend container.

- [ ] **Step 6: Implement `stop-local.ps1`**

Accept `[switch]$Clean`. Run `docker compose --env-file .env.local down` and append `--volumes` only when `-Clean` is present. Restore LM Studio with `lms server stop` followed by `lms server start --port 1234 --bind 127.0.0.1`.

- [ ] **Step 7: Run GREEN**

```powershell
cd server
npm test -- test/localDeploymentConfig.test.js
cd ..
docker compose --env-file .env.example config --quiet
```

- [ ] **Step 8: Commit**

```powershell
git add .gitignore .env.example docker-compose.yml scripts/start-local.ps1 scripts/stop-local.ps1 server/test/localDeploymentConfig.test.js
git commit -m "feat: add one-command local stack"
```

## Task 7: Real Local Smoke, Documentation, and Final Verification

**Files:**
- Create: `server/src/scripts/smoke-local.js`
- Create: `server/test/smokeLocal.test.js`
- Modify: `server/package.json`
- Modify: `README.md`

- [ ] **Step 1: Write failing smoke helper tests**

Export `runLocalSmoke({ baseUrl, fetchFn, cleanupFn })`. With a fake fetch sequence, assert it:

1. Registers a unique `smoke-<timestamp>` user.
2. Reads the default ledger.
3. Creates at least three records with distinct semantic content.
4. Polls readiness until Qdrant indexing is observable.
5. Sends an exact query and asserts `data.finance` exists.
6. Sends an advice query and asserts `data.rag.sources.length > 0`.
7. Calls cleanup in `finally`, including on assertion failure.

- [ ] **Step 2: Run RED**

```powershell
cd server
npm test -- test/smokeLocal.test.js
```

- [ ] **Step 3: Implement smoke runner and package command**

Use only public HTTP APIs for setup and queries. Implement cleanup through an injected cleanup function in unit tests and a production cleanup path that directly deletes the unique smoke user rows and corresponding Qdrant points after the HTTP assertions. Add:

```json
"smoke:local": "node src/scripts/smoke-local.js"
```

Never print auth tokens or full prompts.

- [ ] **Step 4: Update README**

Replace stale SQLite/Vercel deployment instructions with:

- Prerequisites: Docker Desktop, LM Studio, both exact model IDs.
- `powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1`.
- URLs: frontend `http://localhost`, backend `http://localhost:3000/api/health/ready`.
- Stop and clean commands.
- Explanation of SQL-first exact queries and RAG advice.
- LM Studio binding security note.
- Troubleshooting for missing model, port 1234, dimension mismatch, unhealthy Docker service, and reindex command.

- [ ] **Step 5: Run automated verification**

```powershell
cd server
npm test
cd ..\client
npm run build
cd ..
docker compose --env-file .env.example config --quiet
```

Expected: all backend tests pass, Vite build succeeds, Compose config is valid.

- [ ] **Step 6: Run the real one-command local deployment**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

Expected: script reports ready MySQL, Redis, Qdrant, backend, frontend, LM Studio models, Embedding, Chat, and a passing RAG smoke.

- [ ] **Step 7: Verify security and scope**

```powershell
git grep -n -E "sk-[A-Za-z0-9]{16,}|JWT_SECRET=.*[^}]$" -- . ":(exclude).env.example"
git diff --check master...HEAD
git status --short
```

Expected: no real key output; only intentional phase 10 files are committed. Existing unrelated user changes remain unstaged.

- [ ] **Step 8: Commit**

```powershell
git add server/src/scripts/smoke-local.js server/test/smokeLocal.test.js server/package.json README.md
git commit -m "docs: finish local rag runbook"
```

- [ ] **Step 9: Final review**

Request a spec-compliance review and a code-quality review over `master...HEAD`. Fix every Critical or Important issue, rerun the complete automated verification, and rerun the real local smoke after any runtime-affecting fix.
