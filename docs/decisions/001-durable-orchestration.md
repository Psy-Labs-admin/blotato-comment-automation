# ADR 001 — Temporal moves the run, Postgres keeps the facts

Accepted.

Someone takes two days to answer the pricing question. A deployment must preserve their deadline, rule version and next step.

Temporal workflows own durable waits, timers and progress. Postgres holds conversation ownership, rule versions, replies and send history. Creating a run also saves its start command transactionally, so the outbox relay can deliver it after a crash.

A Postgres scheduler would save a service but require timer recovery, leases and inspection tools. A queue would scatter conversation progress across consumers.

We accept another service and deterministic workflow code. Changes need replay tests and patches or compatible [pinned builds](../worker-upgrades.md). Database constraints still protect ownership and retry safety. Temporal cannot make an Instagram call atomic with a database commit.
