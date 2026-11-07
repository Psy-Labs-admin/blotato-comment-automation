# ADR 001: Temporal for orchestration, Postgres for facts

**Status:** accepted

## Context

A run waits for a human for up to days, then must continue exactly where it stopped. That has to
hold across deploys, crashes and outages. It needs durable timers, retries with backoff, and a way to
see what each run is doing. At the same time several things must be decided atomically with data:
which message answered which question, whether a send was attempted, who owns a conversation.

## Options

1. **Postgres only** (`runs.next_step_at` + a polling scheduler with leases). One fewer service.
   But we would build and own a scheduler: timer recovery, lease expiry, fairness, back-pressure,
   retry policies and an inspection UI. That is a second workflow engine, written for a take-home.
2. **Queue (SQS/Kafka/BullMQ) + delayed messages.** Good for fire-and-forget. Multi-day waits,
   cancellation, "what is this run doing now?" and per-run ordering become application code spread
   across consumers.
3. **Temporal** for ordering and time, **Postgres** for facts and invariants.

## Decision

Option 3. One workflow per run. Temporal owns step order, durable timers and retry schedules.
Every decision that must be race-free is an idempotent activity under a Postgres row lock. There is
no second executor in Postgres. Commands to Temporal go through a transactional outbox, because
there is no transaction spanning both systems.

## Consequences

- (+) Waits survive anything. Deadlines are durable timers. The Temporal UI shows each run's history.
- (+) Postgres constraints, not workflow code, enforce every "at most once".
- (−) One more piece of infrastructure (self-hosted or Temporal Cloud), and its cost per waiting run.
- (−) Workflow code must stay deterministic. Changes need `patched()` / Worker Versioning and replay tests.
- (−) Signals are not facts: the design treats them as wake-ups only, which costs one extra DB read per wake-up.
- If Blotato already runs a different durable engine, the same split applies to it. Swapping the
  engine does not change the data model or the send protocol.
