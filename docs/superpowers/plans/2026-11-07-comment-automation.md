# Comment-Triggered Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable backend that turns an Instagram comment containing a keyword into a durable conversation (public reply → DM question → wait for email → DM with link), with every reliability claim of the spec backed by an automated test against real PostgreSQL and a real Temporal server.

**Architecture:** One TypeScript codebase, three logical roles (API, Temporal worker, outbox relay) that run in one process for the demo or separately. PostgreSQL owns facts and invariants (inbox, conversation ownership, input consumption, send ledger, leads, outbox, audit). Temporal owns "what happens next" (step order, durable timers, waits). External platforms (Instagram, CRM, Telegram) sit behind adapters; local fakes are real HTTP servers with fault injection so "accepted but the response was lost" is a genuine network event, not a mocked exception.

**Tech Stack:** Node ≥ 20.3 (dev on 24), TypeScript (strict, CommonJS), Fastify 5, `pg`, zod, Temporal TS SDK 1.25, prom-client, Vitest, Docker Compose (postgres:16-alpine, temporalio/auto-setup:1.27.2, temporalio/ui:2.34.0).

**Spec:** `../../../../outputs/Blotato-system-design-plan.md` (Russian; sections referenced as §N). Scope decision from the user: everything in §13 must work in code, including CRM sync, grouped alerts (Telegram adapter), metrics and timeline.

## Global Constraints

- Every outbound platform action goes through the intent ledger (`message_intents` + `message_attempts`); the reservation commits **before** the HTTP call; no DB lock is held during network I/O.
- HTTP adapters never retry internally (single `fetch` with `AbortSignal.timeout`).
- A send whose outcome is uncertain becomes `unknown` and is never resent automatically; only authoritative evidence (adapter lookup by `clientRef`, or a late result for the same attempt) or an audited operator decision resolves it.
- One active run per conversation (`conversations.owner_run_id`), held while any intent of that run is `in_flight`/`unknown`.
- One inbox event is consumed by at most one wait (`input_consumptions` PK = inbox event id).
- Wait deadline = `prompt_started_at + timeout`, fixed when the first prompt attempt is reserved; never extended by retries, clarification, restart or recovery.
- Workflow code is deterministic: imports only `@temporalio/workflow` and type-only domain imports; all I/O in activities.
- No message text, emails or tokens in logs, metrics labels, alert texts or Temporal payloads beyond what a step needs (activities return ids, not emails).
- Every tenant-facing query filters by `tenant_id`; external ids are always scoped by `connection_id`.
- Reason codes are string constants from `src/domain/reasons.ts`; audit rows always carry one.
- Ports: Postgres host 55432 (local PG already on 5432), Temporal 7233, Temporal UI 8233, API 3000, fake Instagram 4001, fake CRM 4002, fake alert sink 4003.

## Review Focus

1. Keyword inside another word or with punctuation (`"pricingplan"`, `"#Pricing!"`, `"PRICING?"`) → only whole-word matches trigger (`#Pricing!` matches, `pricingplan` does not). Test in Task 2.
2. Reply with an email wrapped in prose and punctuation (`"sure: Alice@Example.COM."`) → captured as `Alice@example.com`; two different emails → `ambiguous`, never guessed. Test in Task 2.
3. Webhook for an unknown account or with a malformed body → 4xx, no inbox row, no crash. Test in Task 4.
4. Comment written by the connected account itself (echo of our own reply) → stored as `ignored_self`, never starts a run (otherwise our "Sent you a DM!" could loop). Test in Task 4.
5. A DM from someone with no active run (ordinary inbox traffic) → stored with outcome `no_active_run`, zero sends. Test in Task 4.

---

### Task 1: Scaffold, infrastructure, schema, DB test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `compose.yaml`, `.env.example`, `.gitignore`
- Create: `migrations/001_init.sql`, `src/config.ts`, `src/storage/db.ts`, `src/storage/migrate.ts`, `src/domain/clock.ts`
- Test: `tests/helpers/db.ts`, `tests/integration/schema.test.ts`

**Interfaces:**
- Produces: `withTx<T>(db: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T>`; `migrate(db: Pool): Promise<void>`; `createTestDb(): Promise<{ db: Pool; drop(): Promise<void> }>`; `Clock { now(): Date }`, `systemClock`.
- Schema (all tables carry `tenant_id` except `tenants`): `tenants`, `social_connections` (unique `(platform, external_account_id)`, `status`, `sends_paused`, `capabilities jsonb`), `automations` (`priority`, `status`, `cooldown_seconds`, `active_version_id`), `automation_versions` (unique `(automation_id, version)`, `definition jsonb`), `conversations` (unique `(connection_id, participant_id)`, `owner_run_id`, `last_inbound_seq`, `opted_out`, `human_takeover`, `last_run_finished_at`, `last_inbound_dm_at`), `inbox_events` (unique `(connection_id, event_type, provider_event_key)`, `seq`, `received_at`, `occurred_at`, `routing_status`, `routing_outcome`, `run_id`), `automation_runs` (unique `trigger_event_id`, `workflow_id`, `status`, `current_step`), `run_controls`, `input_waits` (unique `(run_id, step_id)`, `status`, `boundary_seq`, `prompt_started_at`, `deadline`, `clarifications_used`, `consumed_event_id`, `lead_id`), `input_consumptions` (PK `inbox_event_id`), `message_intents` (unique `(run_id, step_id, action_no)`, `fingerprint`, `status`, `current_attempt_id`, `provider_message_id`, `wait_id`), `message_attempts` (unique `(intent_id, attempt_no)`), `send_budget` (PK `(connection_id, window_start)`), `outbox` (unique `idempotency_key`, `next_attempt_at`, `locked_until`), `leads` (unique `run_id`), `incidents` (partial unique open `(connection_id, error_class)`), `run_audit_events`.

- [ ] **Step 1:** `compose.yaml` with postgres (55432, db `blotato`), temporal auto-setup on the same postgres (`DB=postgres12`), temporal UI. `docker compose up -d`; expect `temporal` healthy within ~60s.
- [ ] **Step 2: Failing test** `schema.test.ts`: `"rejects a duplicate inbox event key"` — insert tenant/connection/conversation, insert inbox event twice with same `(connection_id,'comment.created','c1')` → second insert throws code `23505`. `"rejects a second consumption of one inbox event"` → `23505`.
- [ ] **Step 3:** Implement migration, `db.ts`, `migrate.ts` (applies `migrations/*.sql` in order, records in `schema_migrations`), `tests/helpers/db.ts` (creates `test_<uuid>` database, migrates, drops on teardown).
- [ ] **Step 4:** `npx vitest run tests/integration/schema.test.ts` → PASS. Commit `chore: scaffold, schema and db harness`.

### Task 2: Domain rules

**Files:** Create `src/domain/definition.ts`, `src/domain/matching.ts`, `src/domain/reasons.ts`, `src/domain/types.ts`. Test `tests/unit/definition.test.ts`, `tests/unit/matching.test.ts`.

**Interfaces:**
- `AutomationDefinitionSchema` (zod) / `type AutomationDefinition = { schemaVersion: 1; trigger: { type: 'comment.created'; platform: 'instagram'; keyword: string; match: 'whole_word_case_insensitive'; posts: 'all_supported' | { mediaIds: string[] } }; steps: Step[] }`
- `Step = { id; type: 'reply_comment'; text } | { id; type: 'send_private_reply'; text } | { id; type: 'await_input'; validator: 'email'; timeout: string; maxClarifications: number; clarificationText: string; promptStep: string } | { id; type: 'send_message'; text }`
- `parseDefinition(input: unknown): AutomationDefinition` — throws `DefinitionError { issues: string[] }`. Structural rules: unique step ids; `await_input.promptStep` names an earlier `send_private_reply`/`send_message` immediately before it; `send_message` only after an `await_input` (the participant must have written to us — §9); `maxClarifications` 0..3; timeout 1s..30d.
- `parseDuration(s: string): number` (ms; `"72h"`, `"30m"`, `"5s"`, `"7d"`).
- `matchesKeyword(text: string, keyword: string): boolean` — NFKC, lowercase, tokens split on non-letter/digit.
- `extractEmail(text: string): { kind: 'valid'; email: string } | { kind: 'none' } | { kind: 'ambiguous'; count: number }` — distinct addresses compared case-insensitively; domain lowercased; trailing punctuation stripped.
- `isStopCommand(text: string): boolean` — whole message is `stop`/`unsubscribe` (case-insensitive).
- `Reason` constants used everywhere (e.g. `CONVERSATION_BUSY`, `LOWER_PRIORITY`, `COOLDOWN`, `OPTED_OUT`, `HUMAN_TAKEOVER`, `NO_MATCH`, `IGNORED_SELF`, `NO_ACTIVE_RUN`, `NO_ACTIVE_WAIT`, `BEFORE_PROMPT`, `AFTER_DEADLINE`, `RUN_CANCELLED`, `CONNECTION_INACTIVE`, `SENDS_PAUSED`, `WINDOW_CLOSED`, `RATE_LIMITED`, `RECIPIENT_LIMIT`, `ATTEMPT_OUTCOME_LOST`, `PROVIDER_TIMEOUT`, …).

- [ ] **Step 1: Failing tests:** `matchesKeyword("#Pricing!", "pricing") === true`; `matchesKeyword("pricingplan", "pricing") === false`; `matchesKeyword("PRICING?", "pricing") === true`; `extractEmail("sure: Alice@Example.COM.")` → `{kind:'valid', email:'Alice@example.com'}`; `extractEmail("a@x.io or b@y.io").kind === 'ambiguous'`; `extractEmail("A@x.io and a@X.io").kind === 'valid'`; `extractEmail("no idea").kind === 'none'`; `parseDuration("72h") === 259200000`; `parseDefinition(validFourStep)` passes; definition with `send_message` before any `await_input` → `DefinitionError`; duplicate step ids → `DefinitionError`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Commit `feat(domain): definition schema and matching rules`.

### Task 3: Platform adapters and HTTP fakes

**Files:** Create `src/adapters/instagram.ts`, `src/adapters/crm.ts`, `src/adapters/alerts.ts`, `src/fakes/fake-instagram.ts`, `src/fakes/fake-crm.ts`, `src/fakes/fake-alert-sink.ts`. Test `tests/integration/adapters.test.ts`.

**Interfaces:**
- `type SendKind = 'comment_reply' | 'private_reply' | 'dm'`
- `type SendRequest = { kind: SendKind; accountId: string; commentId?: string; recipientId?: string; text: string; clientRef: string }`
- `type SendOutcome = { status: 'accepted'; providerMessageId: string; httpStatus: number } | { status: 'rejected'; code: string; httpStatus: number } | { status: 'not_sent'; code: string; retryAfterMs: number; httpStatus: number } | { status: 'unknown'; code: string; httpStatus?: number }`
- `interface SocialPlatform { send(req: SendRequest): Promise<SendOutcome>; lookupByClientRef?(accountId: string, clientRef: string): Promise<{ found: true; providerMessageId: string } | { found: false }> }` — `HttpInstagramAdapter(baseUrl, { timeoutMs })`. Classification: 2xx → accepted; 400/403 with permanent code → rejected; 429 or 503 with `x-not-processed: 1` → not_sent (retry-after header); timeout / socket reset / other 5xx → unknown.
- `interface CrmClient { upsertLead(e: LeadCapturedEvent, idempotencyKey: string): Promise<void> }` (throws on failure) — `HttpCrmClient`.
- `interface AlertNotifier { notify(text: string): Promise<void> }` — `TelegramNotifier(token, chatId)` (real Bot API), `HttpAlertSink(url)`.
- Fakes: `startFakeInstagram(port?): Promise<FakeInstagram>` with `url`, `sent(): SentMessage[]`, `pushFault(f: Fault)`, `reset()`, `close()`; `Fault = { mode: 'ok' | 'reject_permanent' | 'rate_limit' | 'unavailable' | 'accept_then_drop' | 'delay'; delayMs?: number; kind?: SendKind }`. Same controls over HTTP: `POST /__control/faults`, `GET /__control/sent`, `POST /__control/reset`. `accept_then_drop` records the message, then destroys the socket. Lookup endpoint `GET /v1/:account/messages?client_ref=`. `startFakeCrm()` with `setDown(boolean)`, `records()` (dedupes by idempotency key, counts deliveries). `startFakeAlertSink()` with `received()`.

- [ ] **Step 1: Failing tests:** `ok` → accepted with id; `reject_permanent` → rejected; `rate_limit` → not_sent with retryAfterMs > 0; `accept_then_drop` → outcome `unknown` **and** `fake.sent()` has 1 message; `delay` longer than adapter timeout → unknown; `lookupByClientRef` finds the dropped message; CRM upsert twice with one key → one record, 2 deliveries; CRM down → throws.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(adapters): instagram/crm/alert adapters with fault-injecting fakes`.

### Task 4: Ingest and routing

**Files:** Create `src/ingest/events.ts`, `src/ingest/ingest.ts`, `src/ingest/router.ts`, `src/storage/audit.ts`, `src/storage/outbox.ts`, `src/storage/admin.ts`. Test `tests/integration/routing.test.ts`, helper `tests/helpers/fixtures.ts`.

**Interfaces:**
- `NormalizedEventSchema` (zod, discriminated by `type`): `comment.created { accountId, commentId, mediaId, from: { id, username? }, text, occurredAt }`, `message.received { accountId, messageId, from: { id }, text, occurredAt, isEcho? }`.
- `ingestEvent(deps: { db: Pool; clock: Clock }, raw: unknown): Promise<{ status: 'accepted'; eventId: string; duplicate: boolean } | { status: 'rejected'; httpStatus: 400 | 404; reason: string }>` — one tx: resolve connection, upsert + `FOR UPDATE` conversation, insert inbox (`ON CONFLICT DO NOTHING`), assign `seq`, `received_at = clock.now()`, echo/self → routing done with `IGNORED_SELF`; DM updates `last_inbound_dm_at`; STOP sets `opted_out` and enqueues `cancelRequested` for the owner run.
- `routeEvent(deps, eventId: string): Promise<RouteOutcome>` and `routePending(deps, limit?): Promise<number>` (sweeper). Comment routing under the conversation lock: match active automations (priority desc, id asc), audit losers as `LOWER_PRIORITY`, check opted-out/takeover/busy/cooldown/connection status, create run + `run_controls` + set `owner_run_id` + outbox `workflow.start` (key `start:<runId>`). DM routing: owner run's wait `prepared|active` with `boundary_seq` set and `seq > boundary_seq` → outbox `workflow.signal inboxChanged` (key `signal:<eventId>`); otherwise `NO_ACTIVE_RUN` / `NO_ACTIVE_WAIT` / `BEFORE_PROMPT`.
- `enqueueOutbox(c: PoolClient, m: { tenantId: string; kind: OutboxKind; idempotencyKey: string; payload: object; availableAt?: Date }): Promise<void>`; `OutboxKind = 'workflow.start' | 'workflow.signal' | 'crm.lead_captured' | 'alert.notify'`.
- `audit(c, e: { tenantId; runId?; conversationId?; eventId?; type: string; reason?: string; data?: object }): Promise<void>`
- Fixtures: `seedTenant(db, { name, accountId, capabilities? }): Promise<{ tenantId; connectionId; accountId }>`, `createAutomation(db, tenantId, connectionId, definition, { priority?, cooldownSeconds? })`.

- [ ] **Step 1: Failing tests:** same comment ingested 5× concurrently → 1 inbox row, 1 run; two different comments from one participant concurrently → 1 run, other `CONVERSATION_BUSY`; two automations match → higher priority wins, loser audited `LOWER_PRIORITY`; second trigger within cooldown after completion → `COOLDOWN`; self comment → `IGNORED_SELF`, no run; unknown account → `rejected 404`, no inbox row; malformed body → `rejected 400`; DM without run → `NO_ACTIVE_RUN`; two tenants with identical participant/comment ids on different accounts → two isolated runs.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(ingest): durable inbox, deduplication, routing and conversation ownership`.

### Task 5: Outbox relay

**Files:** Create `src/relay/relay.ts`. Test `tests/integration/relay.test.ts`.

**Interfaces:**
- `type OutboxRow = { id: string; tenantId: string; kind: OutboxKind; idempotencyKey: string; payload: any; attempts: number }`
- `type OutboxHandler = (row: OutboxRow) => Promise<void | { retryInMs: number; reason: string }>` (throw = failure with backoff)
- `class OutboxRelay { constructor(o: { db: Pool; kinds: OutboxKind[]; handlers: Partial<Record<OutboxKind, OutboxHandler>>; leaseMs?: number; pollMs?: number; maxAttempts?: number; backoff?: (attempt: number) => number; onDead?: (c: PoolClient, row: OutboxRow, error: string) => Promise<void> }); drainOnce(): Promise<number>; start(): void; stop(): Promise<void>; poke(): void }` — claim with `FOR UPDATE SKIP LOCKED` + lease in a short tx, call handler after commit, then mark done / reschedule with jittered backoff / dead.

- [ ] **Step 1: Failing tests:** two relays drain 50 rows concurrently → each handler invoked exactly once per row; handler throws twice then succeeds → done with `attempts = 3`; always throws → `dead` after `maxAttempts`, `onDead` called; a row with expired lease is reclaimed.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(relay): outbox relay with leases and backoff`.

### Task 6: Send ledger and policy gate

**Files:** Create `src/activities/send.ts`, `src/policy/gate.ts`, `src/activities/deps.ts`. Test `tests/integration/send-ledger.test.ts`.

**Interfaces:**
- `ActivityDeps = { db: Pool; clock: Clock; platform: SocialPlatform; hooks?: { afterProviderCall?(intentId: string): void; afterResultCommit?(intentId: string): void } }` (hooks throw to simulate a worker crash)
- `executeSend(deps, i: { runId: string; stepId: string; actionNo: number }): Promise<SendStepResult>`
- `SendStepResult = { status: 'accepted'; intentId; providerMessageId: string | null } | { status: 'deferred'; intentId; retryAfterMs: number; reason } | { status: 'unknown'; intentId; reason } | { status: 'rejected' | 'blocked' | 'cancelled'; intentId; reason }`
- `checkSendPolicy(c: PoolClient, ctx): Promise<{ ok: true } | { ok: false; outcome: 'blocked' | 'cancelled' | 'deferred'; reason: string; retryAfterMs?: number }>` — order: run cancel → opted-out/takeover → connection inactive/paused → window (`private_reply`: comment age ≤ `privateReplyWindowHours`; `dm`: `last_inbound_dm_at` within `messagingWindowHours`) → per-recipient hourly limit → account budget reservation in `send_budget` (`sendsPerWindow`, `budgetWindowSeconds`).
- `reconcileIntent(deps, i: { intentId: string }): Promise<{ status: 'accepted' | 'retry_allowed' | 'unresolved' }>`
- Protocol: Tx1 (conversation lock) upsert intent → short-circuit on terminal/`unknown` → `in_flight` with existing attempt ⇒ mark `unknown` (`ATTEMPT_OUTCOME_LOST`) → gate → reserve attempt (`pending→in_flight`, new attempt row, `current_attempt_id`) → if intent is a wait prompt, set `boundary_seq`/`prompt_started_at`/`deadline` when null → commit → HTTP → Tx2 fenced on `current_attempt_id` (a late `accepted` for the same attempt resolves an `unknown` intent; anything else stale is recorded on the attempt only) → `unknown` raises incident `send_outcome_unknown`; 401/403 raises `connection_unauthorized` and pauses sends.

- [ ] **Step 1: Failing tests:** re-entry after `accepted` → same id, fake has 1 message; `accept_then_drop` → `unknown`, re-entry → still `unknown`, fake has 1 message; `afterProviderCall` crash then re-entry → `unknown`, 1 message; `afterResultCommit` crash then re-entry → `accepted`, 1 message; `rate_limit` → `deferred`, intent back to `pending`, re-entry sends; `reject_permanent` → `rejected`; `cancel_requested` → `cancelled`, 0 messages; private reply to a 8-day-old comment → `blocked WINDOW_CLOSED`, 0 messages; budget 1 per window, two runs → second `deferred RATE_LIMITED`; `reconcileIntent` on dropped message → `accepted` with provider id; fingerprint of an existing intent never changes.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(send): intent ledger, fencing and policy gate`.

### Task 7: Waits, input consumption, leads

**Files:** Create `src/activities/waits.ts`, `src/activities/runs.ts`, `src/alerts/incidents.ts`. Test `tests/integration/waits.test.ts`.

**Interfaces:**
- `prepareWait(deps, i: { runId; stepId; promptStepId; timeoutMs; maxClarifications }): Promise<{ waitId: string }>` (idempotent per `(run, step)`; links the prompt intent via `wait_id`)
- `activateWait(deps, i: { waitId }): Promise<void>` (`prepared→active`)
- `evaluateWait(deps, i: { waitId; clarificationText: string }): Promise<WaitEvaluation>`; `WaitEvaluation = { kind: 'valid'; leadId: string } | { kind: 'clarify'; actionNo: number } | { kind: 'waiting'; msUntilDeadline: number } | { kind: 'expired' } | { kind: 'cancelled'; reason: string }`. Under the conversation lock: terminal states return their stored result; a created-but-unsent clarification intent is returned again; scan unconsumed events with `seq > boundary_seq AND received_at <= deadline` in seq order; record each in `input_consumptions`; valid → wait consumed + lead + outbox `crm.lead_captured` (key `lead:<leadId>`) in the same tx; invalid/ambiguous → clarification intent if budget remains; nothing left and `now ≥ deadline` → `expired`.
- `finalizeRun(deps, i: { runId; outcome: RunOutcome; reason?: string }): Promise<{ conversationReleased: boolean }>` — releases ownership only when no intent of the run is `in_flight`/`unknown`.
- `setRunStatus(deps, i: { runId; status: RunStatus; step?: string }): Promise<void>`
- `RunOutcome = 'completed' | 'expired' | 'cancelled' | 'failed'`; `RunStatus = 'starting' | 'running' | 'waiting_input' | 'blocked_unknown' | RunOutcome`
- `raiseIncident(c, i: { tenantId; connectionId?; errorClass: IncidentClass; runId? }): Promise<void>`; `resolveIncident(c, i: { tenantId; connectionId?; errorClass }): Promise<void>`; notifications throttled per incident.

- [ ] **Step 1: Failing tests:** email ingested after the prompt reservation but before its result → evaluated once after activation → `valid`; DM before the reservation → `BEFORE_PROMPT`, not consumed; two valid emails evaluated concurrently from two connections → one `valid`, one lead, second call returns same `leadId`; invalid then evaluate twice → one clarification intent, same `actionNo`; second invalid with budget exhausted → `waiting`; email in time + deadline passed → `valid` (not `expired`); no input + deadline passed → `expired`; late email after expiry → stays unconsumed; `finalizeRun` with an `unknown` intent → `conversationReleased: false`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(waits): input consumption, clarifications, leads, incidents`.

### Task 8: Workflow, worker, Temporal relay handlers

**Files:** Create `src/workflows/commentAutomation.ts`, `src/workflows/index.ts`, `src/activities/index.ts`, `src/temporal/worker.ts`, `src/temporal/handlers.ts`, `src/relay/handlers.ts`. Test `tests/helpers/harness.ts`, `tests/integration/workflow.test.ts`.

**Interfaces:**
- Signals: `inboxChanged`, `cancelRequested: [{ reason: string }]`, `intentResolved: [{ intentId: string }]`.
- `commentAutomation(input: { runId: string; definition: AutomationDefinition }): Promise<RunOutcome>` — for each step: send steps → `executeSend` (retry policy max 3 attempts, safe because of the ledger; `deferred` → `sleep(retryAfterMs)` up to 5 times; `unknown` → `reconcileIntent` → else `setRunStatus('blocked_unknown')` and `condition(resolved || cancelled)`); a send step whose next step is `await_input` calls `prepareWait` first and `activateWait` after acceptance; `await_input` loops `evaluateWait` / `condition(inboxDirty || cancelled, msUntilDeadline)`; finally `finalizeRun`.
- `createActivities(deps: ActivityDeps)` returns `{ executeSend, reconcileIntent, prepareWait, activateWait, evaluateWait, finalizeRun, setRunStatus }`.
- `startWorker(o: { deps: ActivityDeps; connection: NativeConnection; taskQueue: string }): Promise<{ shutdown(): Promise<void> }>`
- `temporalHandlers(o: { client: Client; db: Pool; taskQueue: string }): Pick<Record<OutboxKind, OutboxHandler>, 'workflow.start' | 'workflow.signal'>` — start with fixed workflow id `comment-automation-<runId>`, `workflowIdConflictPolicy: 'USE_EXISTING'`; `WorkflowExecutionAlreadyStartedError` = done; signal to a not-yet-started run → retry; to a finished run → done.
- Harness: `createHarness(o?: { relayKinds?: OutboxKind[]; hooks?; capabilities? }): Promise<Harness>` with `db`, `api` (Fastify inject), `ig`, `crm`, `alerts`, `comment(...)`, `dm(...)`, `waitForRun(runId, predicate)`, `restartWorker()`, `stopWorker()`, `startWorker()`, `close()`.

- [ ] **Step 1: Failing tests:** happy path → public reply, private reply, DM link sent once each in order; run `completed`; lead `synced`; conversation released. Invalid reply → one clarification, then valid → completed. No reply with `timeout: "2s"` → `expired`, conversation released, 2 messages total. New version published mid-wait → old run's link text is the old one; next run uses the new one.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(workflow): durable comment automation workflow`.

### Task 9: API, timeline, funnel, metrics, alert and CRM delivery

**Files:** Create `src/api/server.ts`, `src/api/routes/*.ts`, `src/observability/metrics.ts`, `src/observability/logger.ts`, `src/timeline.ts`, `src/relay/integrations.ts`, `src/main.ts`. Test `tests/integration/api.test.ts`.

**Interfaces:**
- `buildServer(deps: { db; clock; relayPoke?: () => void; routeAsync?: boolean }): FastifyInstance`. Routes: `POST /webhooks/instagram`; `POST /automations`, `POST /automations/:id/versions`, `POST /automations/:id/disable`, `GET /automations/:id`; `GET /runs?status=`, `GET /runs/:id`, `GET /runs/:id/timeline`, `POST /runs/:id/cancel`; `GET /conversations/:id/timeline`, `POST /conversations/:id/opt-out`, `POST /conversations/:id/takeover`; `POST /intents/:id/resolve { resolution: 'accepted' | 'not_sent', note }`; `GET /funnel`; `GET /metrics`; `GET /health`. Tenant context via `x-tenant-id` header on every non-webhook route.
- `buildTimeline(db, tenantId, runId): Promise<TimelineEntry[]>` — `{ at: string; kind: string; text: string; reason?: string; refs: Record<string,string> }`, merged from audit, intents, attempts, waits, lead.
- `integrationHandlers(o: { db; crm: CrmClient; notifier: AlertNotifier }): Pick<Record<OutboxKind, OutboxHandler>, 'crm.lead_captured' | 'alert.notify'>`
- `main.ts`: `ROLE=all|api|worker|relay`, `FAKES=1` starts fakes in-process.

- [ ] **Step 1: Failing tests:** cancel returns `202 { status: 'cancel_requested' }` and writes `run_controls` + outbox in one tx; other tenant's `x-tenant-id` → 404 on run/timeline; resolve on a non-`unknown` intent → 409; funnel counts by run cohort (`matched_comments, runs_started, prompts_accepted, emails_captured, links_accepted, crm_synced`); `/metrics` exposes `outbox_oldest_pending_seconds` and `intents_unknown`; publishing an invalid definition → 400 with issues.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(api): management api, timeline, funnel, metrics and integrations`.

### Task 10: Failure scenarios on real infrastructure

**Files:** Test `tests/failure-scenarios/*.test.ts` (one file per group: `duplicates`, `crash-and-unknown`, `restart`, `races`, `crm-and-alerts`, `cancel-and-stop`).

- [ ] **Step 1: Write the tests** (all through the harness, real Postgres + Temporal + HTTP fakes):
  - duplicate comment webhook ×5 → one run, `ig.sent()` has exactly 3 messages after completion;
  - `afterProviderCall` crash on the link DM → run `blocked_unknown` → fake lookup reconciles → `completed`, link sent exactly once;
  - `accept_then_drop` on link DM with lookup disabled → `blocked_unknown`, conversation held, alert sink got one grouped incident; `POST /intents/:id/resolve accepted` → `completed`, no resend;
  - `afterResultCommit` crash → `completed`, every step sent once;
  - worker stopped during wait, email posted, worker restarted → `completed`, `deadline` unchanged;
  - email posted with signal relay paused, deadline passes, relay resumed → `completed` (not `expired`);
  - email delivered while the prompt response is delayed 1.5s → `completed`, link once;
  - two emails posted concurrently → one lead, one link;
  - CRM down → run `completed`, lead `pending`; CRM up → `synced`, CRM records = 1;
  - cancel during wait → `cancelled`, no further sends, conversation released;
  - cancel while link intent `unknown` → `cancelled`, conversation still held until resolve;
  - `STOP` DM during wait → `cancelled` with `OPTED_OUT`, zero sends afterwards, new comment → `OPTED_OUT`;
  - connection 401 on public reply → run `failed`, sends paused, incident raised.
- [ ] **Step 2:** `npm test` → all PASS (fix production code where they fail). Commit `test: failure scenarios against real postgres and temporal`.

### Task 11: Demo, docs, AI disclosure

**Files:** Create `scripts/demo.ts`, `scripts/seed.ts`, `README.md`, `docs/design.md`, `docs/decisions/001-durable-orchestration.md`, `docs/decisions/002-external-send-guarantees.md`, `docs/decisions/003-conversation-ownership.md`, `docs/operations.md`, `docs/demo.md`, `AI_USAGE.md`.

- [ ] **Step 1:** `scripts/demo.ts` drives the running stack over HTTP: happy path, duplicate webhook, uncertain send + operator resolve, CRM outage; prints timelines.
- [ ] **Step 2:** Docs in English. README: problem → product contract → architecture diagram → guarantees table (each row links to its test) → run instructions → limitations. `design.md` is the full English design (data model, execution model, reliability, concurrency, Instagram constraints, observability, scaling). `AI_USAGE.md` states plainly what the candidate decided and what AI produced.
- [ ] **Step 3:** `docker compose up -d && npm run dev` + `npm run demo` → all demo scenarios print expected outcomes. Commit `docs: design, decisions, demo and AI usage`.

### Task 12: Final verification

- [ ] `npm run typecheck` → 0 errors; `npm test` → all green; fresh-clone run per README works. Whole-branch review by a fresh reviewer; fix findings. Final commit.
