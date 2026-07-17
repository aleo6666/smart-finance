# Smart Finance V3 Phase 1 Design

Date: 2026-07-17
Status: Draft approved for implementation planning

## Goal

Implement the first V3 phase for Smart Finance using the existing Node/Express backend as the only backend line.

Phase 1 focuses on a stable infrastructure migration and one verifiable V3 business loop:

User natural-language bookkeeping -> Planner Agent -> Recorder Agent -> MySQL records -> Redis task/status -> Qdrant record vector -> Monitor/Observe first pass.

## Confirmed Boundaries

- Backend target: existing `server` Node/Express app.
- Database target: migrate from SQLite `server/finance.db` directly to MySQL.
- Runtime target: Docker Compose development environment.
- Required infrastructure: MySQL 8, Redis 7, Qdrant, backend, frontend.
- AI services: real adapters are required, but missing API keys must not block local verification.
- First business loop: natural-language bookkeeping through `/api/chat`.
- OCR workflow, human review pages, full observability dashboard, and WeChat confirmation links are out of Phase 1.

## Current-State Notes

- Root scripts currently start `server/src/index.js` and the Vue client.
- `server/src/db.js` is the SQLite entry point and auto-creates tables in `finance.db`.
- Existing `docker-compose.yml` starts only frontend/backend and still configures SQLite storage.
- V3 document expects MySQL, Redis, Qdrant, Agent queueing, layered context, observability, and human review.
- The repository has many unrelated dirty/untracked changes. Implementation must avoid reverting or reformatting unrelated files.

## Phase 1 Functional Requirements

1. Docker Compose starts all Phase 1 services.
2. Backend connects to MySQL as the primary database.
3. Existing SQLite data from `server/finance.db` is migrated into MySQL.
4. `/api/chat` keeps its public behavior but routes record creation through the Agent flow.
5. Planner Agent classifies natural-language bookkeeping requests and creates a task.
6. Recorder Agent persists valid record tasks to MySQL.
7. Redis stores Agent tasks and task status.
8. New records are embedded into Qdrant.
9. Missing embedding API keys use a deterministic local fallback vector so the Qdrant path remains verifiable.
10. Monitor Agent runs after record creation and creates budget reminders when thresholds are crossed.
11. Observe first pass records Agent/LLM/embedding activity or exposes enough structured stats to validate the flow.
12. Existing auth and device compatibility should remain usable where possible.

## Non-Goals For Phase 1

- OCR confirmation workflow.
- `/api/records/ocr` behavior changes beyond preserving compatibility.
- Human review pages: `OcrConfirmPage.vue`, `AlertConfirmPage.vue`.
- Full Vue observability dashboard.
- WeChat subscription confirmation deep links.
- Bad Case JSONL export.
- Complete long-term conversation memory summarization.
- Rewriting the Java `finance-backend` project.

## Proposed Architecture

### Services

Docker Compose should include:

- `mysql`: MySQL 8 with a named data volume.
- `redis`: Redis 7 for queue/status/cache.
- `qdrant`: Qdrant vector database.
- `backend`: Node/Express service.
- `frontend`: Vue/Vite build served by nginx, keeping current deployment shape.

### Backend Data Layer

Introduce a MySQL data access layer using Knex. Keep the SQL surface close to the existing route behavior, but replace direct `better-sqlite3` access for Phase 1 paths.

The migration should create MySQL schema for the currently used core tables:

- `users`
- `ledgers`
- `records`
- `record_attachments`
- `budgets`
- `goals`
- `reminders`
- `wechat_subscribe`
- `reports`
- `report_shares`
- `report_templates`
- `exchange_rates`
- `feedback`
- `devices`

Add minimal V3 Phase 1 tables:

- `agent_tasks`
- `llm_calls`
- `ocr_evaluations` as schema only, not OCR flow integration
- `cost_alert_rules`

### SQLite To MySQL Migration

Provide a repeatable migration script that:

- Reads `server/finance.db`.
- Creates MySQL schema if needed.
- Copies core tables.
- Preserves primary IDs where safe.
- Converts SQLite text timestamps to MySQL datetime-compatible values.
- Can be run from Docker or local Node.
- Reports table-by-table counts.

The script should be idempotent for development by either using upsert behavior or a documented reset path. The implementation plan should choose the safer concrete behavior before coding.

### Agent Flow

Phase 1 Agent flow should be intentionally small:

1. `POST /api/chat` parses the incoming message through existing NLU logic.
2. If the intent is bookkeeping and amount/category/date are present, Planner creates a task.
3. Recorder consumes or executes the task and writes the record to MySQL.
4. Recorder updates task status in Redis and `agent_tasks`.
5. Recorder calls vector memory to embed/upsert the record into Qdrant.
6. Recorder triggers Monitor for budget threshold checks.
7. Observe records the major steps and exposes a stats endpoint.
8. `/api/chat` returns a response compatible with the current frontend.

Redis Streams should be used for the queue path. For local request/response ergonomics, the first implementation may support synchronous waiting for the specific task result with a timeout, while still recording the queue/status path.

### Vector Memory

Implement `vectorMemory` with:

- Qdrant collection initialization.
- Record text block generation.
- Embedding adapter.
- Upsert by record ID.
- Search API skeleton usable by later Analyzer work.

Embedding behavior:

- With `OPENAI_API_KEY`: call the configured embedding model.
- Without `OPENAI_API_KEY`: generate a deterministic fixed-size local vector for development only.

### Monitor First Pass

After a new expense record:

- Query the user's matching monthly budget.
- Sum current month spending in the category.
- If spending reaches 80% or 100%, create a reminder.
- Avoid duplicate reminders for the same user/category/month/threshold where practical.

### Observe First Pass

Phase 1 observe should prioritize structured verification over a complete dashboard:

- Record AI/embedding/Agent activity in MySQL where possible.
- Add `GET /api/observe/stats` with basic aggregate data.
- Return enough data to verify that `/api/chat` produced task, record, vector, and monitor/observe activity.

## API Compatibility

Keep these routes usable:

- `POST /api/chat`
- `GET /api/records`
- `POST /api/records`
- Existing auth/ledger/report routes that are needed by the current frontend.

Response shapes should remain compatible with the current Vue app unless a route is newly introduced.

## Configuration

Update `.env.example` with at least:

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `REDIS_HOST`
- `REDIS_PORT`
- `VECTOR_DB_URL`
- `VECTOR_COLLECTION`
- `OPENAI_API_KEY`
- `EMBEDDING_MODEL`
- `ZHIPU_API_KEY`
- `ANTHROPIC_API_KEY`
- `JWT_SECRET`
- `UPLOADS_DIR`

Secrets must not be hardcoded in source. Existing hardcoded service keys should be moved to environment configuration during implementation if touched.

## Verification Plan

Phase 1 is complete when these checks pass:

1. `docker compose up` starts MySQL, Redis, Qdrant, backend, and frontend.
2. MySQL schema exists.
3. SQLite migration reports copied row counts.
4. Backend health endpoint succeeds.
5. Auth or mock login can obtain a usable identity.
6. `POST /api/chat` with a natural-language expense writes a MySQL record.
7. Redis contains task/status evidence for that request.
8. Qdrant contains a vector point for the new record.
9. Monitor creates a reminder when a budget threshold test case is prepared.
10. `GET /api/observe/stats` returns non-empty activity after the chat flow.
11. Existing frontend build succeeds.

## Risks And Mitigations

- Schema mismatch between SQLite and V3 MySQL: implement schema and migration together, then verify counts.
- Agent async behavior complicates `/api/chat`: keep a bounded synchronous wait for Phase 1 while preserving Redis task status.
- Missing API keys could block verification: use deterministic local embedding fallback and existing NLU fallback.
- Dirty worktree could hide unrelated changes: inspect before editing each touched file and commit only intentional files if committing.
- Full V3 scope could expand Phase 1: keep OCR review, full dashboard, and WeChat confirmation out of this phase.

## Implementation Decisions For Planning

- SQLite migration defaults to non-destructive upsert/copy behavior. A destructive reset must require an explicit flag or separate command.
- Phase 1 should convert currently active backend routes to the MySQL data layer. SQLite remains only as the migration source, not as a runtime compatibility database.
- `agent_tasks` should include: `id`, `task_id`, `user_id`, `agent_type`, `intent`, `status`, `payload_json`, `result_json`, `error_message`, `created_at`, `updated_at`, `completed_at`.
- Agent status values should be: `queued`, `running`, `succeeded`, `failed`, `timeout`.
- Agent consumers should start with the backend process. `/api/chat` should enqueue the task, then wait for its specific result with a short timeout while preserving Redis/task status evidence.
