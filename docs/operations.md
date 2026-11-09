# Operations runbook

## Processes

| Role | Command | Scales by | Stateless |
|---|---|---|---|
| API | `ROLE=api npm start` | webhook rate | yes |
| Worker | `ROLE=worker npm start` | active activities (not waiting runs) | yes |
| Relay + sweeper | `ROLE=relay npm start` | outbox throughput | yes (rows are leased) |

All roles apply migrations under an advisory lock. Set the deployment environment before startup. See `.env.example`.

## API access

The browser console and the supported machine API have separate credentials. Deploy PostgreSQL, Temporal and authenticated integration services on trusted networks. The [integration guide](integration.md) is the canonical client contract, backed by [OpenAPI](../src/api/openapi.json); a running service serves `/docs`. The [public site](https://psy-labs-admin.github.io/blotato-comment-automation/) hosts documentation only.

- **Operator access:** `TENANT_TOKEN_HASHES` maps tenant UUIDs to SHA-256 digests of distinct, high-entropy operator tokens. These authenticate the legacy operator endpoints. Browsers exchange an operator credential or one-use ticket for an eight-hour HttpOnly, SameSite=Strict session. Browser writes require `x-csrf-token`. An HTTPS `CONSOLE_ORIGIN` must match the external console host for public-host cookie sessions. Operator credentials are not retained in browser storage.
- **Machine access:** `/api/v1` accepts only independently issued `blt_` bearer keys. `read` permits GET/HEAD; `write` also permits mutations. PostgreSQL `integration_keys` stores the named key's tenant, SHA-256 digest, scope and revocation timestamp; every request checks the row, so revocation applies to subsequent requests across replicas. Cookies, operator tokens and monitoring tokens cannot substitute for a machine key. A conflicting `x-tenant-id` returns 403; tenant identity always comes from the key. Foreign resource IDs are scoped to that tenant. Query/body schemas reject unsupported tenant overrides.
- **Monitoring:** `METRICS_TOKEN_HASH` protects `GET /metrics` with its own token. Public `/live`, `/health` and `/ready` report process, database and pipeline health respectively; they do not grant customer-data access.
- **Gateway ingress:** only gateway mode exposes `/webhooks/instagram`. `WEBHOOK_SIGNING_SECRET` authenticates normalized events from the trusted upstream integration. Send Unix seconds in `x-webhook-timestamp` and `sha256=<lowercase hex>` in `x-webhook-signature`, using HMAC-SHA256 over timestamp, literal dot and exact UTF-8 request bytes. Retries outside five minutes need a fresh signature; provider event IDs still deduplicate.
- **Native ingress:** `/integrations/instagram/webhook` verifies Meta signatures over the raw body with `META_APP_SECRET`. Its GET verification token is separate. Login, encrypted account credentials and refresh are described in [Instagram setup](instagram.md).
- `HOST` defaults to loopback. The public console shell contains no customer data. Never place credentials in URLs, tracked files or shared output.

Issue keys from the trusted operator machine after startup has applied migrations:

```sh
TOKEN=$(npm run --silent api:key -- create reporting)
npm run api:key -- list
npm run api:key -- revoke <key-uuid>
# Use create publishing --write for a client that needs mutations.
```

Default local invocation reads the private `operator/service.env` and `operator/credentials.json` under `BLOTATO_LOCAL_DIR` (default `.local`), verifies the database binding and uses that installation's tenant. To select an explicit environment, supply **both** `DATABASE_URL` and `BLOTATO_TENANT_ID`; supplying only one fails. Creation writes only the new secret to stdout and fixed metadata to stderr. Listing returns safe ID/name/scope/status metadata; the secret cannot be recovered. Provision a replacement key, switch the client and revoke the old key to rotate it. Revocation verifies tenant ownership.

Set `CONSOLE_ORIGIN` to the public HTTPS origin to include an authenticated run-inspection link in operational alerts. The console can run on loopback without a public origin.

## Signals to watch

The following are the actual thresholds in [deploy/monitoring/alerts.yml](../deploy/monitoring/alerts.yml), including Prometheus's required continuous firing duration. They are separate from application incident grouping.

| Alert | Condition | Duration |
|---|---|---|
| `AutomationApiUnavailable` | Metrics scrape fails or the API target list is absent | 1 min |
| `AutomationRoleUnavailable` | A required worker/relay role has no fresh successful observation | 1 min |
| `AutomationDeliveryLag` | Oldest pending delivery exceeds 120 seconds for a configured destination | 2 min |
| `AutomationDeadDelivery` | A configured destination has any dead delivery | 1 min |
| `AutomationRoutingLag` | Oldest unrouted inbox event exceeds 60 seconds and pipeline is configured | 1 min |
| `AutomationUnknownSend` | Oldest unknown send exceeds 300 seconds | 1 min |

Role observations run every 10 seconds and expire after 45 seconds. A healthy replacement replica can keep its role available. Optional unconfigured CRM, metadata and notification destinations do not trigger queue alerts. Configure `EXPECTED_DELIVERIES` when the API must require consumers whose credentials exist only on relay deployments. `/health` alone is not pipeline readiness. See [monitoring and external alert setup](monitoring.md) for metrics, role requirements, rule checks and independent monitoring deployment.

## Incident playbooks

Each Telegram/sink alert names the class, account, number of affected conversations and the action.

### `send_outcome_unknown`: Instagram may or may not have received a message
1. `GET /runs?needsReview=true` (operator authentication) and open each run's `GET /runs/:id/timeline`.
2. Check the conversation in the Instagram inbox (or the provider's logs, if available).
3. `POST /intents/:id/resolve` with `{"resolution":"accepted","note":"…"}` if the message is there, or
   `{"resolution":"not_sent","note":"…"}` to authorise **one** deliberate new attempt.
4. The incident closes itself when no unknown sends remain for the account.

Never bulk-resolve as `not_sent`. That is how people get duplicate DMs.

### `connection_unauthorized`: token revoked or expired
Sends for the account are paused and new triggers are suppressed (`connection_inactive`).
Conversations in progress wait at the gate instead of failing. After the provider confirms a fresh connection, an outstanding manual pause can be cleared with
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
Conversations are unaffected. Leads stay `pending` and retry with backoff. Fix the configured CRM destination. The incident resolves when its outstanding leads sync. Exhausted rows become dead (`outbox.status = 'dead'`, lead `crm_status = 'failed'`). Recover through **Operations**, using the selected delivery's current revision and an operator reason.

The equivalent operator request is `POST /operator/deliveries/:id/retry` with `{"expectedGeneration":"<current generation>","note":"<reason>"}`. Cookie-authenticated requests also need the session's CSRF header. A stale revision returns 409. The transaction locks the row, checks tenant ownership, target existence and a healthy consumer, increments the retry generation, clears the lease and records an audit event. The original idempotency key is preserved. The CRM must honor it; a timed-out upstream call can still have ambiguous effects.

### `outbox_dead_letter`

Inspect stopped deliveries and the related incident in **Operations**. Only stopped CRM and metadata jobs with an applicable target and a healthy matching consumer offer retry. Already-synced or missing leads cannot be restarted. Use the revision-checked request above after correcting the cause; direct SQL updates bypass these safeguards.

Social sends and Temporal commands have no generic replay control. Start/signal commands retry indefinitely, so inspect their lag and role health during Temporal outages. An unknown social send requires the evidence-based intent resolution flow. Notification retries are automatic and bounded; stopped notifications cannot be replayed through the ordinary retry API. Correct the destination and inspect its persisted receipt and incident history; see [Telegram delivery behavior](telegram.md#delivery-behavior).

## Controls

| Need | Call | Effect |
|---|---|---|
| Stop one run | `POST /runs/:id/cancel` | gate refuses further sends; workflow ends `cancelled`; an in-flight send may still land |
| Person asks to stop | DM "STOP" (automatic) or `POST /conversations/:id/opt-out` | no automated sends to them again |
| Agent takes over | `POST /conversations/:id/takeover` / `release-takeover` | takeover cancels the active run and blocks new automation; release permits future triggers and does not restart the cancelled run |
| Hold an account | `POST /connections/:id/pause` / `resume` | sends wait at the gate (up to 24 h) and no new runs start; resume continues conversations in progress |
| Stop an automation | `POST /automations/:id/disable` | no new runs; running ones continue |
| Change copy/link | `POST /automations/:id/versions` | new runs only |

## Deploying

The [public documentation site](https://psy-labs-admin.github.io/blotato-comment-automation/) is not an application deployment or webhook host. Live native Instagram requires a stable reachable HTTPS origin, registered callback and webhook paths, applicable Meta app permissions/account eligibility, explicit capability limits and encrypted token storage. This implementation uses Instagram Login; it does not consume Meta Unified Login / Facebook Login for Business configuration IDs. Follow [Instagram deployment prerequisites](instagram.md#before-enabling-a-workspace) and the [public callback deployment example](instagram.md#deploy-a-public-callback-host).

Provision persistent PostgreSQL and Temporal, private operator configuration, provider secrets and backups before starting the configured roles. `compose.deploy.yaml` supplies an application container and Caddy TLS proxy; it does not provision the database, Temporal, DNS or a hosting account. Configure an independent monitor when host failure must be detected. An API-only installation supports editing and diagnosis but cannot deliver messages.


- **Definitions** are data: new versions affect new runs only.
- **Workflow code** must stay replay-compatible with running histories. Use `patched()` for small
  changes, and Temporal Worker Versioning (pinned deployments) for larger ones. Keep old workers
  until their runs drain. CI replays a recorded history from the previous version. Add representative histories when changing command order.
- **Schema**: additive migrations first, code second, cleanup later. Activities must tolerate both
  shapes during a rollout.

## Metadata and data retention

The metadata relay fetches post context asynchronously after durable inbox acceptance, using the native Graph adapter in native mode or the normalized upstream endpoint in gateway mode. A successful response is cached per account and media for one hour. Access-denied and missing responses are cached for five minutes. The run inspector shows the most recently fetched snapshot and its timestamp. A metadata outage leaves the conversation free to proceed.

Set `INBOX_RETENTION_ENABLED=1` and `INBOX_RETENTION_DAYS` to opt in to redaction. Every minute the relay redacts up to 100 routed inbox bodies older than the cutoff and records the redaction time. It skips conversations with an owner, an unfinished run, an open wait or an uncertain send. Event identity, ordering and audit records survive, so a repeated delivery still deduplicates. Lead retention is a separate customer policy.


Inbox bodies, leads, metadata and backups can contain customer content. Use encrypted storage and restrict backup access. Keep provider secret keys outside version control.

See [tracing and the load check](observability.md) and [pinned worker upgrades](worker-upgrades.md) for reproduction steps.
