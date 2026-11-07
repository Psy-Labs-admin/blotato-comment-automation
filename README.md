# Comment-triggered conversation automations

A durable, auditable backend for turning social comments into customer conversations.

> When someone comments **"pricing"** on any Instagram post: reply *"Sent you a DM!"*, DM them asking
> for their email, wait for the answer, then DM them a link.

It keeps every accepted event, coordinates concurrent replies, and treats an uncertain external
outcome as a first-class state instead of a reason to send twice.

**Read in this order:** this page → [design](docs/design.md) (architecture, data model, execution
model, reliability and concurrency) → [decisions](docs/decisions/) → [demo](docs/demo.md) →
[operations](docs/operations.md) → [AI usage](AI_USAGE.md).

## The idea in one diagram

```mermaid
flowchart LR
    IG[Instagram integration] -->|webhook| API[API: ingest + route]
    API -->|one tx per step| PG[(Postgres: facts)]
    PG -->|outbox| R[Relay]
    R -->|start / signal| T[Temporal: one workflow per run]
    T --> W[Activities] -->|ledger + policy gate| IG
    W --> PG
    R --> CRM[CRM]
    R --> TG[Telegram alerts]
```

- **Postgres owns facts**: deduplicated inbox, who owns a conversation, which message answered which
  question, what was sent, leads. Every "at most once" is a unique constraint.
- **Temporal owns time**: step order, durable multi-day waits, deadlines, bounded retries. Signals are
  only wake-ups; decisions are made by idempotent activities under one row lock per conversation.
- **Sends go through a ledger**: the attempt is reserved and committed *before* the HTTP call. A lost
  acknowledgement becomes `unknown`: the conversation is held, an incident is raised, and nothing is
  resent blindly.

## Guarantees and the tests that prove them

All integration tests run against **real Postgres, a real Temporal server and real HTTP fake
servers**. Faults happen at the socket level: the fake Instagram stores a DM and then drops the
connection. Worker crashes are injected right after the provider call and right after the result
commit.

| Guarantee | Test |
|---|---|
| A webhook delivered 5× concurrently → one run, each message sent once | [duplicates](tests/failure-scenarios/duplicates.test.ts), [routing](tests/integration/routing.test.ts) |
| Same person, two trigger comments at once → one active run, the other `conversation_busy` | [routing](tests/integration/routing.test.ts) |
| Instagram accepted, worker died before recording → **no resend**; reconciled by lookup | [crash-and-unknown](tests/failure-scenarios/crash-and-unknown.test.ts), [send-ledger](tests/integration/send-ledger.test.ts) |
| Worker died after recording → stored result returned, no resend | [crash-and-unknown](tests/failure-scenarios/crash-and-unknown.test.ts) |
| Lost acknowledgement → `unknown`, conversation held, grouped alert, operator resolves, no resend | [crash-and-unknown](tests/failure-scenarios/crash-and-unknown.test.ts) |
| Slow attempt + concurrent retry → retry marks `unknown`; late acceptance of the same attempt resolves it | [send-ledger](tests/integration/send-ledger.test.ts) |
| Email arrives before the question is acknowledged → kept, consumed once after the ack | [races](tests/failure-scenarios/races.test.ts), [waits](tests/integration/waits.test.ts) |
| A DM sent before the question cannot answer it | [waits](tests/integration/waits.test.ts) |
| Two emails at once → one lead, one link | [races](tests/failure-scenarios/races.test.ts) |
| Email on time but its wake-up signal stuck → timer path consumes it, run not expired | [races](tests/failure-scenarios/races.test.ts) |
| Email exactly at the deadline → consumed **or** expired, never both | [races](tests/failure-scenarios/races.test.ts) |
| Worker down during the wait → run resumes, deadline unchanged | [restart](tests/failure-scenarios/restart.test.ts) |
| Relay down / crash between ack and routing → nothing lost | [restart](tests/failure-scenarios/restart.test.ts) |
| No reply → `expired`; a late email is not consumed | [workflow](tests/integration/workflow.test.ts), [waits](tests/integration/waits.test.ts) |
| CRM down → the person still gets the link; lead syncs exactly once later; incident opens and resolves | [crm-and-alerts](tests/failure-scenarios/crm-and-alerts.test.ts) |
| Revoked token → account paused, actionable alert without personal data | [crm-and-alerts](tests/failure-scenarios/crm-and-alerts.test.ts) |
| Windows, per-recipient cap, shared account budget, cancel are enforced right before each send | [send-ledger](tests/integration/send-ledger.test.ts) |
| Editing an automation never changes a running conversation | [workflow](tests/integration/workflow.test.ts) |
| Cancel / STOP / human takeover stop further sends; an unknown send keeps the conversation held | [cancel-and-stop](tests/failure-scenarios/cancel-and-stop.test.ts) |
| Tenants with identical external ids never mix (enforced by composite FKs) | [routing](tests/integration/routing.test.ts), [api](tests/integration/api.test.ts), [schema](tests/integration/schema.test.ts) |

`npm test` → 16 files, 119 tests, about 11 seconds.

## Run it

Requirements: Node ≥ 20.3, Docker (or a local Postgres plus the embedded Temporal dev server).

```bash
npm install
docker compose up -d     # Postgres :55432, Temporal :7233, Temporal UI :8233
npm test                 # uses TEMPORAL_ADDRESS if set, else starts the Temporal dev server itself
npm run dev              # API :3000 + worker + relay + fake Instagram :4001 / CRM :4002 / alert sink :4003
npm run demo             # scripted scenarios with timelines (see docs/demo.md)
```

Tests create a throw-away database per file through `DATABASE_ADMIN_URL`
(default `postgres://postgres:postgres@localhost:55432/postgres`). Without Docker:
`DATABASE_ADMIN_URL=postgres://you@localhost:5432/postgres npm test`, and
`DATABASE_URL=… npm run dev:embedded` for the app.

## API at a glance

| | |
|---|---|
| `POST /webhooks/instagram` | normalised `comment.created` / `message.received` from the existing integration → `202 {eventId, duplicate}` |
| `POST /automations`, `POST /automations/:id/versions`, `…/disable`, `…/enable` | publish immutable, validated definitions |
| `GET /runs?status=`, `GET /runs/:id`, `GET /runs/:id/timeline` | inspect: "why did this run stop?" |
| `GET /events/:id`, `GET /conversations/:id/timeline` | "what happened to this webhook / person?" |
| `POST /runs/:id/cancel`, `POST /conversations/:id/opt-out\|takeover`, `POST /connections/:id/pause\|resume` | controls |
| `POST /intents/:id/resolve` | operator decision on an `unknown` send (`accepted` / `not_sent`, with note) |
| `GET /funnel`, `GET /metrics`, `GET /health` | business funnel by run cohort; Prometheus gauges |

Management routes take `x-tenant-id` as a stand-in for the product's auth.

## Repository map

```
src/domain/       definition schema + validation, keyword/email matching, reason codes, capabilities
src/ingest/       durable inbox (dedup, per-conversation seq), routing, conversation ownership
src/workflows/    the Temporal workflow (deterministic: order, timers, waits)
src/activities/   send ledger, waits/consumption/leads, run finalisation
src/policy/       pre-send policy gate (windows, budget, caps, cancel)
src/relay/        transactional outbox relay; CRM + alert delivery
src/temporal/     worker bootstrap; outbox → Temporal handlers
src/adapters/     Instagram / CRM / Telegram adapters (one attempt, no hidden retries)
src/fakes/        fault-injecting HTTP fakes for Instagram, CRM, alert sink
src/api/          Fastify server: webhooks, management, timeline, funnel, metrics
migrations/       schema with invariants as constraints
tests/            unit, integration, failure-scenarios (real Postgres + Temporal)
docs/             design, ADRs, demo, operations
```

## Scope and honest limits

The Instagram adapter talks to a fake shaped like the Graph API. Blotato's real integration would
sit behind the same `SocialPlatform` interface, and its windows and limits must be confirmed (they
are configuration, not claims). Auth, webhook signature checks, encryption at rest, tracing,
workflow replay tests and load tests are described in the design but not built. The full list is in
[design §15](docs/design.md#15-limitations-and-next-steps).
