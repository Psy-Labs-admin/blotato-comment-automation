# ADR 003: One active run per conversation, serialised by one row lock

**Status:** accepted

## Context

Someone comments "pricing" under two posts, or two automations match the same comment, or an email
arrives while the question is still being sent. Without a rule, two runs ask the same person for
their email at once. Their replies become ambiguous, and messages can be sent twice. Most races in
this system are within one conversation (one account × one participant).

## Decision

- `conversations` has one row per (connected account, participant). **Every state change in a
  conversation takes that row's lock first**: ingest (sequence numbers), routing (ownership), send
  reservation (question boundary and deadline), wait evaluation (consumption, expiry), finalisation.
- `conversations.owner_run_id` is the single active run. A new trigger while it is set is recorded
  as `conversation_busy`. Among several matching automations, one wins by priority; the others are
  audited as `lower_priority`.
- Ownership is released only when the run is finished **and** none of its sends is
  `in_flight`/`unknown`. After release, `cooldown_seconds` prevents an immediate re-trigger.
- Opt-out (STOP), human takeover and cancel are conversation/run controls checked by every send.

## Consequences

- (+) The races that matter (email vs question ack, two emails, email vs timer, STOP vs
  clarification) become sequential decisions with one outcome each.
- (+) Contention is per person. A viral post spreads across many rows and does not create a hotspot.
- (−) A person cannot be in two automations at once. That is the intended product rule for v1. A
  future "queue the second automation" option would build on the same ownership row.
- (−) Without a platform `reply_to` reference we infer that a DM answers our question (boundary + one
  active run). We cannot prove it, and the design document states this.
