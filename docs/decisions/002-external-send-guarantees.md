# ADR 002: External sends: a ledger with an explicit `unknown` state

**Status:** accepted

## Context

Instagram's send API and our database share no transaction, and the Send API has no idempotency
key. Every send has a window in which the message may have been accepted but our record of it does
not exist yet. A timeout, a reset socket, a worker killed after the HTTP call, an activity
start-to-close timeout: all of them land in that window. Temporal's activity retries do not close
it. They make it worse if the activity simply calls the API again.

## Options

1. **Retry on failure** (at-least-once): duplicate DMs on every lost acknowledgement. That is the
   failure customers notice most.
2. **Mark sent before calling** (at-most-once): silent losses. The person never gets the link, and
   nothing says so.
3. **Ledger + reservation + `unknown`**: automatic retry only when the attempt *provably* had no
   effect. Everything else becomes `unknown`, holds the conversation and is resolved by evidence.

## Decision

Option 3 (`src/activities/send.ts`):

- one `message_intents` row per logical action, `unique(run, step, action_no)`, immutable fingerprint;
- Tx1 under the conversation lock: short-circuit on any recorded outcome, turn a dangling
  `in_flight` into `unknown`, run the policy gate, reserve the attempt. **Commit before the HTTP call;**
- adapter: one call, timeout, no internal retries. Results are classified as
  `accepted / rejected / not_sent / unknown`;
- Tx2 is fenced on `current_attempt_id`. A late acceptance of the *same* attempt is authoritative
  and resolves an `unknown`. Other stale results are recorded on the attempt only;
- `unknown` is resolved only by authoritative evidence: an adapter lookup by client reference (when
  the contract has one) or an audited operator decision. Never by matching text or timestamps;
- the conversation stays held while any send is `in_flight`/`unknown`, so no other automation
  talks to the person until we know what they received.

## Consequences

- (+) No duplicate DM from retries, crashes or concurrent workers (tested with real sockets and
  simulated crashes at both dangerous points).
- (+) Losses are never silent: `unknown` is a visible state with an incident, a metric and a timeline line.
- (−) Some sends need a human. That is the honest cost of a provider without idempotency. If Meta
  (or another platform) offers dedup keys or a lookup, the adapter declares it and those cases
  resolve automatically.
- (−) Budget reserved for an unknown send is not refunded (conservative: the platform may have counted it).
