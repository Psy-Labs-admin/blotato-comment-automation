# Operations runbook

## Processes

Load the deployment environment from your secret store before starting each role. See `.env.example`. All roles apply migrations under an advisory lock.

| Role | Start | Scale for |
|---|---|---|
| API | `ROLE=api npm start` | Webhook traffic |
| Worker | `ROLE=worker npm start` | Active activities |
| Relay and sweeper | `ROLE=relay npm start` | Outbox throughput |

You can restart any of the three. If a relay dies mid-job, another can pick it up once its lease expires.

## API access

Keep dependencies on trusted networks. `HOST` defaults to loopback. See the [machine API contract](integration.md), [OpenAPI](../src/api/openapi.json) or running `/docs`.

| Access | Credential and behavior |
|---|---|
| Operator console and legacy endpoints | `TENANT_TOKEN_HASHES` maps tenant UUIDs to SHA-256 token digests. Use distinct high-entropy tokens. Browsers exchange a credential or one-use ticket for an eight-hour HttpOnly, SameSite=Strict session. Browser writes require `x-csrf-token`. Set HTTPS `CONSOLE_ORIGIN` to the external console host for public-host cookies and alert links. |
| Machine `/api/v1` | Independently issued `blt_` bearer key. `read` allows GET/HEAD, `write` allows mutations too. Each request checks its stored tenant, scope and revocation. A conflicting `x-tenant-id` returns 403. Resource lookups stay tenant-scoped. |
| Monitoring `/metrics` | Separate bearer token whose digest is `METRICS_TOKEN_HASH`. Public `/live`, `/health` and `/ready` expose health checks. |
| Gateway `/webhooks/instagram` | `WEBHOOK_SIGNING_SECRET`. HMAC-SHA256 over timestamp, literal dot and exact UTF-8 body. Send Unix seconds in `x-webhook-timestamp` and `sha256=<lowercase hex>` in `x-webhook-signature`. Re-sign retries older than five minutes. Event IDs still deduplicate. |
| Native `/integrations/instagram/webhook` | `META_APP_SECRET` verifies the raw body. GET verification uses a separate token. See [Instagram setup](instagram.md). |

Issue machine keys from a trusted operator machine after migrations have run.

```sh
TOKEN=$(npm run --silent api:key -- create reporting)
npm run api:key -- create publishing --write
npm run api:key -- list
npm run api:key -- revoke <key-uuid>
```

The CLI verifies the database binding using private `operator/service.env` and `operator/credentials.json` under `BLOTATO_LOCAL_DIR`, default `.local`. Explicit environments require both `DATABASE_URL` and `BLOTATO_TENANT_ID`. Creation prints the secret once. Rotate by replacing the key, switching clients, then revoking. Keep credentials out of URLs, tracked files and shared output.

## Signals to watch

[alerts.yml](../deploy/monitoring/alerts.yml) requires each condition to hold for the listed duration. Application incidents group separately.

| Alert | Condition | Duration |
|---|---|---|
| `AutomationApiUnavailable` | Failed metrics scrape or absent API target list | 1 min |
| `AutomationRoleUnavailable` | Required role has no fresh successful observation | 1 min |
| `AutomationDeliveryLag` | Configured destination's oldest pending row exceeds 120 seconds | 2 min |
| `AutomationDeadDelivery` | Configured destination has a dead row | 1 min |
| `AutomationRoutingLag` | Configured pipeline's oldest unrouted event exceeds 60 seconds | 1 min |
| `AutomationUnknownSend` | Oldest unknown send exceeds 300 seconds | 1 min |

See [monitoring](monitoring.md) for role health, destination expectations and external alerts.

## Incident playbooks

### `send_outcome_unknown`

Inspect `GET /runs?needsReview=true` and `GET /runs/:id/timeline` with operator authentication. Check Instagram or provider logs, then `POST /intents/:id/resolve`.

```json
{"resolution":"accepted","note":"Confirmed in Instagram"}
```

Use `{"resolution":"not_sent","note":"<evidence>"}` only after confirming absence. It authorizes one deliberate new attempt. Bulk resolution can duplicate DMs. The incident closes when the account has no unknown sends.

### `connection_unauthorized`

Restore the provider connection and clear manual pause with `POST /connections/:id/resume`. New triggers were suppressed. Waiting runs continue within about a minute. Those held over 24 hours have failed and need a fresh trigger.

### Runs ending as `activity_failed` or `workflow_closed`

`activity_failed` means a dependency kept failing for roughly 15–20 minutes. `workflow_closed` means the orphan reconciler found the workflow gone. An in-flight send becomes `unknown`. Investigate that outcome before releasing the conversation. People can trigger again after the cooldown once unresolved work is cleared.

### `crm_delivery_failing`

Fix the CRM destination. Conversations continue while pending leads retry with backoff. Exhausted rows become dead and lead `crm_status` becomes `failed`.

In **Operations**, select the delivery and retry with its current revision and a reason. The equivalent operator request is `POST /operator/deliveries/:id/retry`.

```json
{"expectedGeneration":"<current generation>","note":"<reason>"}
```

Cookie requests need CSRF. Stale revisions return 409. Retry checks ownership, target and consumer health, preserving the idempotency key. The CRM must honor it after timeouts. See [recovery](monitoring.md#recovery).

### `outbox_dead_letter`

Fix the cause in **Operations**, then retry eligible CRM/metadata jobs. Synced or missing leads cannot restart. Direct SQL bypasses safeguards.

Temporal start/signal commands retry indefinitely. Watch lag and role health. Resolve social sends through intents. Review stopped notification receipts using the [Telegram guide](telegram.md#delivery-behavior).

## Controls

These calls use operator authentication and CSRF for cookie sessions.

| Need | Call | Effect |
|---|---|---|
| Stop a run | `POST /runs/:id/cancel` | Blocks further sends and ends the workflow. An in-flight message may land. |
| Stop contacting someone | DM `STOP` or `POST /conversations/:id/opt-out` | Blocks future automation for that person. |
| Agent takeover | `POST /conversations/:id/takeover` or `/release-takeover` | Takeover cancels the run and blocks automation. Release permits future triggers. |
| Hold an account | `POST /connections/:id/pause` or `/resume` | Blocks new runs and holds sends for up to 24 hours. Resume continues waiting runs. |
| Disable automation | `POST /automations/:id/disable` | Blocks new runs. Existing runs continue. |
| Change copy or links | `POST /automations/:id/versions` | Applies to new runs. |

## Deploying

Provision persistent PostgreSQL, Temporal, private configuration, integration secrets and backups. `compose.deploy.yaml` supplies the app container and Caddy TLS proxy. You supply the database, Temporal, DNS and hosting. An API-only installation can edit and diagnose. Delivery needs the configured worker and relay.

Native Instagram uses Instagram Login and needs reachable HTTPS callbacks/webhooks, eligible accounts, Meta permissions, capability limits and encrypted tokens. Follow [deployment prerequisites](instagram.md#before-enabling-a-workspace) and the [callback-host example](instagram.md#deploy-a-public-callback-host).

Use `patched()` for small workflow changes and [pinned workers](worker-upgrades.md) for larger ones. Replay representative histories after command-order changes. Ship additive migrations, then compatible code, then cleanup.

## Metadata and data retention

Metadata fetches follow durable acceptance through Graph in native mode or upstream in gateway mode. Success caches for one hour, missing/access-denied responses for five minutes. The inspector shows snapshot time. Metadata outages don't block conversations.

Opt into body redaction with `INBOX_RETENTION_ENABLED=1` and `INBOX_RETENTION_DAYS`. Every minute, the relay redacts up to 100 routed bodies older than the cutoff. It skips owned conversations, unfinished runs, open waits and uncertain sends. Identity, ordering and audit records remain for deduplication. Set lead retention separately. Encrypt customer data and backups, restrict access and keep provider keys outside version control.
