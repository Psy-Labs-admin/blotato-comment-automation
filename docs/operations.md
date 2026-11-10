# Operations runbook

## Processes

Load secrets from your deployment secret store. See [`.env.example`](../.env.example). Each role migrates under an advisory lock.

| Role | Start | Add replicas for |
|---|---|---|
| API | `ROLE=api npm start` | Webhook traffic |
| Worker | `ROLE=worker npm start` | Active activities |
| Relay and sweeper | `ROLE=relay npm start` | Outbox throughput |

If a relay dies mid-job, another relay can pick it up when the lease expires.

## API access

Keep dependencies on trusted networks. `HOST` defaults to loopback. See the [machine API guide](integration.md), [OpenAPI](../src/api/openapi.json) or running `/docs`.

| Caller | Access |
|---|---|
| Console and legacy endpoints | `TENANT_TOKEN_HASHES` maps tenant UUIDs to SHA-256 token digests. Use distinct high-entropy tokens. Signing in with a credential or a one-use ticket starts an eight-hour HttpOnly, SameSite=Strict session. Cookie writes need `x-csrf-token`. Set public HTTPS `CONSOLE_ORIGIN` for cookies and alert links. |
| Machine `/api/v1` | Separate `blt_` bearer keys. `read` permits GET/HEAD, `write` adds mutations. Requests check tenant, scope and revocation. Conflicting `x-tenant-id` gets 403. Lookups stay tenant-scoped. |
| Monitoring | `/metrics` needs the separate bearer token matching `METRICS_TOKEN_HASH`. `/live`, `/health` and `/ready` are public. |
| Gateway `/webhooks/instagram` | Sign with `WEBHOOK_SIGNING_SECRET` using HMAC-SHA256 over the timestamp, a literal dot and the exact UTF-8 body. Send Unix seconds in `x-webhook-timestamp` and `sha256=<lowercase hex>` in `x-webhook-signature`. Send provider IDs exactly as issued. Padded IDs return 400. Re-sign retries older than five minutes. Event IDs still deduplicate. |
| Native `/integrations/instagram/webhook` | `META_APP_SECRET` verifies the raw body. GET verification has its own token. Follow [Instagram setup](instagram.md). |

Issue keys from a trusted machine after migrations.

```sh
TOKEN=$(npm run --silent api:key -- create reporting)
npm run api:key -- create publishing --write
npm run api:key -- list
# To revoke a key, paste its management ID and press Enter.
read -r KEY_ID
npm run api:key -- revoke "$KEY_ID"
```

The CLI checks binding against private `operator/service.env` and `operator/credentials.json` in `BLOTATO_LOCAL_DIR` (default `.local`). Explicit environments need `DATABASE_URL` and `BLOTATO_TENANT_ID`. Secrets print once. Replace, switch clients, then revoke. Keep secrets out of URLs, Git and shared output.

## Signals to watch

Prometheus uses [alerts.yml](../deploy/monitoring/alerts.yml). Conditions must hold for the listed duration. Incidents group separately.

| Alert | Condition | Duration |
|---|---|---|
| `AutomationApiUnavailable` | Metrics scrape fails or the API target list is empty | 1 min |
| `AutomationRoleUnavailable` | A required role has no fresh successful observation | 1 min |
| `AutomationDeliveryLag` | Oldest pending job for a configured destination is over 120 seconds old | 2 min |
| `AutomationDeadDelivery` | A configured destination has a dead job | 1 min |
| `AutomationRoutingLag` | Oldest unrouted event in a configured pipeline is over 60 seconds old | 1 min |
| `AutomationUnknownSend` | Oldest uncertain send is over 300 seconds old | 1 min |

See [monitoring](monitoring.md) for destinations, role health and notification setup.

## Incident playbooks

### `send_outcome_unknown`

Authenticate as an operator. Inspect `GET /runs?needsReview=true` and `GET /runs/:id/timeline`. Check Instagram or provider logs, then `POST /intents/:id/resolve`.

```json
{"resolution":"accepted","note":"Confirmed in Instagram"}
```

Use `{"resolution":"not_sent","note":"<evidence>"}` only after confirming absence. An active run can make one new attempt. A finished run cancels that intent. The incident clears when the account has no unknown sends left.

### `connection_unauthorized`

Reconnect the account. Native login clears a provider-imposed pause and preserves a manual hold. Use `POST /connections/:id/resume` only when you intend to lift that hold. Look at each waiting run’s timeline. A deferred send can wait up to 24 hours, and its Instagram messaging window can close sooner.

### Runs ending as `activity_failed` or `workflow_closed`

`activity_failed` means a dependency failed for roughly 15–20 minutes. `workflow_closed` means the orphan reconciler found the workflow gone. An in-flight send becomes `unknown`. Check before releasing the conversation. Clear unresolved work and wait for cooldown before retriggering.

### `crm_delivery_failing`

Fix the CRM destination. Conversations continue while lead deliveries retry with backoff. Exhausted jobs become dead and the lead’s `crm_status` becomes `failed`.

Retry in **Operations** with current revision and reason, or call `POST /operator/deliveries/:id/retry`.

```json
{"expectedGeneration":"<current generation>","note":"CRM credentials replaced"}
```

Cookies need CSRF. Stale revisions get 409. Retry checks ownership, target and consumer health, preserving the idempotency key. The CRM must honor it after timeouts. See [recovery](monitoring.md#recovery).

### `outbox_dead_letter`

Fix the cause in **Operations**, then retry eligible CRM or metadata jobs. Synced or missing leads cannot restart. Direct SQL bypasses checks and auditing.

Temporal start/signal commands retry indefinitely. Watch lag and role health. Resolve social intents. Inspect stopped notifications through [Telegram receipts](telegram.md#delivery-behavior).

## Controls

Authenticate as an operator. Cookie writes need CSRF.

| Task | Call | What happens |
|---|---|---|
| Stop a run | `POST /runs/:id/cancel` | Ends the workflow and blocks further sends. An in-flight message may still arrive. |
| Stop contacting someone | DM `STOP` or `POST /conversations/:id/opt-out` | Blocks future automation for that person. |
| Hand over to an agent | `POST /conversations/:id/takeover` or `/release-takeover` | Takeover cancels the run and blocks automation. Release allows future triggers. |
| Hold an account | `POST /connections/:id/pause` or `/resume` | Blocks new runs and holds sends for up to 24 hours. Resume continues waiting runs. |
| Disable automation | `POST /automations/:id/disable` | Stops new runs. Existing runs continue. |
| Update copy or links | `POST /automations/:id/versions` | New runs use the new version. |

## Deploying

Supply persistent PostgreSQL, Temporal, hosting, DNS, private configuration, secrets and backups. [`compose.deploy.yaml`](../compose.deploy.yaml) provides app and Caddy TLS proxy. API-only installs support editing and diagnosis. Delivery needs worker and relay.

Native Instagram needs public HTTPS callbacks/webhooks, eligible accounts, Meta permissions, capability limits and encrypted tokens. Follow the [prerequisites](instagram.md#before-enabling-a-workspace) and [callback-host example](instagram.md#deploy-a-public-callback-host).

Use `patched()` for small workflow changes, [pinned workers](worker-upgrades.md) for larger ones. Replay histories after command-order changes. Ship additive migrations, compatible code, then cleanup.

## Metadata and data retention

After durable acceptance, fetch metadata through Graph in native mode or upstream in gateway mode. Cache success for an hour, missing/access-denied for five minutes. Inspect snapshot time. Outages leave conversations running.

Enable body redaction with `INBOX_RETENTION_ENABLED=1` and set `INBOX_RETENTION_DAYS`. The relay redacts up to 100 expired routed bodies per minute, skipping owned conversations, unfinished runs, open waits and uncertain sends. Identity, ordering and audit remain for deduplication.

Set lead retention separately. Encrypt data/backups, restrict access, keep keys outside Git and manage other copies.
