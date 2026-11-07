# How this was built: my work and AI's

The task asked for a short write-up of which parts I developed myself and where I used AI. Here it
is, stated plainly.

## Summary

AI did most of the production work in this repository: the code, the tests and the documentation.
My role was setting the problem framing and the priorities, choosing the scope and depth, reviewing
the plan, and deciding how the work would be executed and verified. The architecture follows a
design plan written beforehand in an AI-assisted planning session, which I directed.

## Timeline

1. **Design plan** (before this repository). An AI-assisted session (research of Temporal / Postgres
   / Meta documentation, architecture options, independent critique) produced a detailed plan in
   Russian. I set the business priorities and the depth: every step must be thought through,
   especially reliability. The plan chose TypeScript + Temporal + PostgreSQL, the ledger with an
   explicit `unknown` state, one active run per conversation, and a working prototype with fault
   injection.
2. **Scope decision** (mine). Everything in the plan's "minimal strong implementation" had to
   work in code rather than be only described: CRM sync, grouped Telegram-style alerts, metrics,
   timeline, and failure scenarios on real infrastructure.
3. **Implementation** (AI: Claude Code, model Claude Opus 5.5, in an agentic session). The AI wrote
   a task-by-task implementation plan (`docs/superpowers/plans/`), then the schema, domain rules,
   adapters and fakes, ingest/routing, outbox relay, send ledger, waits, workflow, API, tests, demo
   and docs. Each task followed test-first: a failing test, then the code, then a green run. I
   approved the plan and chose inline execution with one final review.
4. **Verification** (AI-run, results reproducible): `npm run typecheck` is clean, and `npm test` passes
   the full suite on real Postgres + a real Temporal dev server, repeated runs to check for flakiness.
   `npm run demo` was run against the live stack (output excerpt in `docs/demo.md`).

## Decisions the AI made during implementation (for my review)

These were taken during implementation without asking me, and are recorded so I can defend or change them:

- STOP is applied in the same transaction as ingesting the message, not during routing. Otherwise a
  concurrent evaluation could answer "STOP" with a clarification DM.
- The prompt send (not `prepareWait`) links the question to its wait and fixes the boundary and
  deadline. The send intent does not exist when the wait is prepared.
- `reconcileIntent` never treats "not found" as proof of non-delivery. Only positive evidence or an
  operator resolves an `unknown`.
- Per-recipient frequency limit **blocks** (not defers): exceeding it signals spam-like behaviour.
- A revoked account suppresses new triggers at routing (`connection_inactive`) instead of failing them at the send gate.
- An `unknown`-send incident closes itself when no unknown sends remain for the account. This gap
  was found while writing the failure scenarios and fixed test-first.
- Metrics are DB-derived gauges at scrape time (true across processes) rather than in-process counters.
- Added endpoints beyond the plan: account pause/resume, takeover release, `GET /events/:id`.
- The unknown-send reason was renamed `provider_no_confirmation` (with the provider code shown in
  the timeline): the demo showed a dropped connection labelled as a "timeout".

## Bugs and corrections found by running things, not by reading

- A refused-connection test used port 1, which `fetch` blocks as an unsafe port. The test was wrong,
  not the adapter.
- Gate order: an unauthorised account reported `connection_inactive` instead of the more actionable `sends_paused`.
- A concurrency test assumed which of two simultaneous DMs wins the row lock. It was made order-independent.
- The "stuck signal" scenario finished too fast to prove anything, because the email could be read
  before the workflow parked. It now waits for the timer and asserts the lead was created after the deadline.

## What was not verified

- `docker compose up` was **not** exercised end to end on the machine where this was built (its
  Docker disk was full). Tests and the demo ran against a local PostgreSQL 15 and the official
  Temporal dev server (`@temporalio/testing`), and the same code reads `DATABASE_URL` /
  `TEMPORAL_ADDRESS` for the compose setup.
- No real Instagram, CRM or Telegram account was used. Meta's exact windows and limits are configuration to confirm.
- No load testing.

## My own contribution: to be completed by me before submission

<!-- Replace this section with your own words: what you personally reviewed, changed, rejected or
     would do differently, and which decisions you can defend in the interview. Do not leave it
     claiming more (or less) than you actually did. -->
- _To be written by the candidate._
