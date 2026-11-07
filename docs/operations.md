# Operations runbook

## Processes

| Role | Command | Scales by | Stateless |
|---|---|---|---|
| API | `ROLE=api npm start` | webhook rate | yes |
| Worker | `ROLE=worker npm start` | active activities (not waiting runs) | yes |
| Relay + sweeper | `ROLE=relay npm start` | outbox throughput | yes (rows are leased) |

All roles run migrations on start (serialised by an advisory lock). Configuration: `.env.example`.

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
1. `GET /runs?status=blocked_unknown` (tenant header) and open each run's `GET /runs/:id/timeline`.
2. Check the conversation in the Instagram inbox (or the provider's logs, if available).
3. `POST /intents/:id/resolve` with `{"resolution":"accepted","note":"…"}` if the message is there, or
   `{"resolution":"not_sent","note":"…"}` to authorise **one** deliberate new attempt.
4. The incident closes itself when no unknown sends remain for the account.

Never bulk-resolve as `not_sent`. That is how people get duplicate DMs.

### `connection_unauthorized`: token revoked or expired
Sends for the account are paused and new triggers are suppressed (`connection_inactive`). After the
customer reconnects: `POST /connections/:id/resume`. Runs that failed are not restarted
automatically, because a stale conversation should not suddenly resume.

### `crm_delivery_failing`
Conversations are unaffected. Leads stay `pending` and are retried with backoff. Fix the CRM side;
the incident resolves on the next successful delivery. Rows that exhaust retries become dead-letter
(`outbox.status = 'dead'`, lead `crm_status = 'failed'`). Redeliver with
`UPDATE outbox SET status='pending', attempts=0, next_attempt_at=now() WHERE id=…` once the cause is
fixed. The idempotency key makes this safe.

### `outbox_dead_letter`
Inspect `SELECT kind, last_error FROM outbox WHERE status='dead'`. Redeliver as above after fixing.

## Controls

| Need | Call | Effect |
|---|---|---|
| Stop one run | `POST /runs/:id/cancel` | gate refuses further sends; workflow ends `cancelled`; an in-flight send may still land |
| Person asks to stop | DM "STOP" (automatic) or `POST /conversations/:id/opt-out` | no automated sends to them again |
| Agent takes over | `POST /conversations/:id/takeover` / `release-takeover` | automation steps back |
| Stop an account | `POST /connections/:id/pause` / `resume` | all automated sends of the account blocked at the gate |
| Stop an automation | `POST /automations/:id/disable` | no new runs; running ones continue |
| Change copy/link | `POST /automations/:id/versions` | new runs only |

## Deploying

- **Definitions** are data: new versions affect new runs only.
- **Workflow code** must stay replay-compatible with running histories. Use `patched()` for small
  changes, and Temporal Worker Versioning (pinned deployments) for larger ones. Keep old workers
  until their runs drain. Add replay tests against exported production histories in CI.
- **Schema**: additive migrations first, code second, cleanup later. Activities must tolerate both
  shapes during a rollout.

## Data retention

`inbox_events.text` and `leads.email` are customer data. Recommended: encrypt at rest, restrict
access, purge `inbox_events.text` after 30–90 days (keep the row and routing outcome for the
funnel), and keep `run_audit_events` (ids and reason codes only) longer. Partition both tables by
month once volume requires it.
