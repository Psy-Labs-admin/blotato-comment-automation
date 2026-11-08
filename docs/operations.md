# Operations runbook

## Processes

| Role | Command | Scales by | Stateless |
|---|---|---|---|
| API | `ROLE=api npm start` | webhook rate | yes |
| Worker | `ROLE=worker npm start` | active activities (not waiting runs) | yes |
| Relay + sweeper | `ROLE=relay npm start` | outbox throughput | yes (rows are leased) |

All roles run migrations on start (serialised by an advisory lock). Configuration: `.env.example`.

## API access

The demo binds to `127.0.0.1` and accepts only loopback Host and same-origin browser requests. `FAKES=1` routes Instagram, CRM and alerts to local simulators even if external settings exist. Development credentials select synthetic tenant data. The API disables this mode when `NODE_ENV=production`.

For a non-demo API set the following secrets through your deployment environment. Use TLS at the trusted ingress and restrict database, Temporal and adapter endpoints to the private service network.

- `TENANT_TOKEN_HASHES` is a JSON object mapping tenant UUIDs to SHA-256 hex digests of distinct, high-entropy operator tokens. Present the original token in `Authorization: Bearer <token>`. Tenant operators can read leads and resolve uncertain sends for their own workspace.
- `METRICS_TOKEN_HASH` is the digest of a separate token for `GET /metrics`.
- `WEBHOOK_SIGNING_SECRET` is a separate shared signing key of at least 32 bytes. The existing Instagram integration verifies Meta's callbacks and signs its normalized JSON for this service. Send Unix seconds in `x-webhook-timestamp` and `sha256=<lowercase hex>` in `x-webhook-signature`. Compute HMAC-SHA256 over timestamp, literal dot and the exact UTF-8 request bytes. Retries outside five minutes need a fresh signature. The original provider event ID still deduplicates the delivery.
- `HOST` defaults to loopback. The read-only public console shell carries no customer data. Operator credentials are held in page memory.

Set `CONSOLE_ORIGIN` to the public HTTPS origin to include an authenticated run-inspection link in operational alerts. The local demo uses its loopback console automatically.

## Signals to watch

| Metric | Meaning | Alert when |
|---|---|---|
| `outbox_oldest_pending_seconds{kind="workflow.start"\|"workflow.signal"}` | trigger → workflow lag | > 30s |
| `outbox_oldest_pending_seconds{kind="crm.lead_captured"}` | CRM backlog | > 15 min |
| `inbox_unrouted_oldest_seconds` | events acknowledged but not routed | > 30s |
| `intents_unknown`, `intents_unknown_oldest_seconds` | uncertain sends holding conversations | any older than 1h |
| `outbox_dead_rows` | deliveries that gave up | > 0 |
| `incidents_open{class}` | grouped incidents (also pushed to Telegram) | per class |
| `runs_by_status{status="blocked_unknown"}` | runs waiting for a decision | > 0 for 1h |

## Incident playbooks

Each Telegram/sink alert names the class, account, number of affected conversations and the action.

### `send_outcome_unknown`: Instagram may or may not have received a message
1. `GET /runs?status=blocked_unknown` (operator bearer token, or tenant header in the local demo) and open each run's `GET /runs/:id/timeline`.
2. Check the conversation in the Instagram inbox (or the provider's logs, if available).
3. `POST /intents/:id/resolve` with `{"resolution":"accepted","note":"…"}` if the message is there, or
   `{"resolution":"not_sent","note":"…"}` to authorise **one** deliberate new attempt.
4. The incident closes itself when no unknown sends remain for the account.

Never bulk-resolve as `not_sent`. That is how people get duplicate DMs.

### `connection_unauthorized`: token revoked or expired
Sends for the account are paused and new triggers are suppressed (`connection_inactive`).
Conversations in progress wait at the gate instead of failing. After the customer reconnects, call
`POST /connections/:id/resume`: waiting conversations continue within about a minute. Sends that
waited longer than 24 h have already failed visibly, and they are not restarted automatically,
because a stale conversation should not suddenly resume.

### Runs ending as `activity_failed` or `workflow_closed`
`activity_failed`: a database or provider dependency kept failing for about 15–20 minutes, so the run
was ended deliberately. `workflow_closed`: the orphan reconciler found the run's workflow gone
(terminated, history limit). In both cases a send that was in flight is now `unknown` (see above),
and the conversation is released only once nothing is unresolved. Investigate the cause; affected
people can trigger again after the cooldown.

### `crm_delivery_failing`
Conversations are unaffected. Leads stay `pending` and are retried with backoff. Fix the CRM side;
the incident resolves once the account's outstanding leads have synced. Rows that exhaust retries become dead-letter
(`outbox.status = 'dead'`, lead `crm_status = 'failed'`). Redeliver with
`UPDATE outbox SET status='pending', attempts=0, next_attempt_at=now() WHERE id=…` once the cause is
fixed. The idempotency key makes this safe.

### `outbox_dead_letter`
Inspect `SELECT kind, last_error FROM outbox WHERE status='dead'`. Redeliver as above after fixing.
CRM, metadata and alert rows can dead-letter. Temporal start/signal commands retry indefinitely, so watch
`outbox_oldest_pending_seconds{kind=~"workflow.*"}` for Temporal outages instead.

## Controls

| Need | Call | Effect |
|---|---|---|
| Stop one run | `POST /runs/:id/cancel` | gate refuses further sends; workflow ends `cancelled`; an in-flight send may still land |
| Person asks to stop | DM "STOP" (automatic) or `POST /conversations/:id/opt-out` | no automated sends to them again |
| Agent takes over | `POST /conversations/:id/takeover` / `release-takeover` | automation steps back |
| Hold an account | `POST /connections/:id/pause` / `resume` | sends wait at the gate (up to 24 h) and no new runs start; resume continues conversations in progress |
| Stop an automation | `POST /automations/:id/disable` | no new runs; running ones continue |
| Change copy/link | `POST /automations/:id/versions` | new runs only |

## Deploying

- **Definitions** are data: new versions affect new runs only.
- **Workflow code** must stay replay-compatible with running histories. Use `patched()` for small
  changes, and Temporal Worker Versioning (pinned deployments) for larger ones. Keep old workers
  until their runs drain. CI replays a recorded history from the previous version. Add representative histories when changing command order.
- **Schema**: additive migrations first, code second, cleanup later. Activities must tolerate both
  shapes during a rollout.

## Metadata and data retention

The metadata relay reads the existing integration's normalized post endpoint after webhook acceptance. A successful response is cached per account and media for one hour. Access-denied and missing responses are cached for five minutes. The run inspector shows the most recently fetched snapshot and its timestamp. A metadata outage leaves the conversation free to proceed.

Set `INBOX_RETENTION_ENABLED=1` and `INBOX_RETENTION_DAYS` to opt in to redaction. Every minute the relay redacts up to 100 routed inbox bodies older than the cutoff and records the redaction time. It skips conversations with an owner, an unfinished run, an open wait or an uncertain send. Event identity, ordering and audit records survive, so a repeated delivery still deduplicates. Lead retention is a separate customer policy.


Inbox bodies, leads, metadata, database backups and simulator receipts can contain customer content. Use encrypted storage and control access to backups. The local interview demonstration uses synthetic conversations.

See [tracing and the load check](observability.md) and [pinned worker upgrades](worker-upgrades.md) for reproduction steps.
