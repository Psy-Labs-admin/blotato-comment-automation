# Monitoring and recovery

`/live` checks the API process. `/health` checks its database connection. `/ready` additionally checks the configured pipeline. An API-only installation with dispatch disabled reports `disabled`; it does not claim that messages can be sent. A configured pipeline requires fresh successful worker and relay observations for its Temporal namespace/task queue. These endpoints have different purposes: a responsive API can remain available for diagnosis while delivery is unavailable.

Every worker replica records its actual SDK worker state and a bounded Temporal RPC probe. Every relay replica checks Temporal connectivity and successful recent drain cycles for every configured destination. Observations run every 10 seconds and expire after 45 seconds. A stopped process records `stopping`; a crashed process expires. Any fresh healthy replica keeps that role available during rolling replacement. A heartbeat is an observation, not a delivery guarantee; backlog and unknown-send metrics detect progress failures independently.

The Operations page reads tenant-scoped persisted facts: grouped pending/stopped deliveries, oldest pending timestamps, open/resolved incidents and notification receipts. Optional CRM, metadata and notification destinations explicitly show when they are unconfigured. Their pending rows remain stored. No invented activity, payload text, emails, transport errors or credentials are returned by these endpoints. Related run references are checked against the same tenant.

A destination can be expected by the API, observed on a healthy relay, or both. Each running relay reports only its supported delivery kinds and an opaque notification destination identity. An expected destination with no matching live consumer makes readiness fail and blocks operator retries for that destination. This also works when only the relay has the provider credentials. The most recent notification receipt shown in Operations belongs to the current destination. Changing the chat starts a separate delivery history.

## Recovery

A stopped CRM or post-metadata delivery can be retried after fixing its configured destination. The request includes the current generation and an operator reason. Row locking, monotonic retry generation and an audit event are committed together. A stale browser/request cannot restart the same delivery again, even if it has failed a second time. The original idempotency key is preserved. A CRM recipient must honor that key; a timed-out CRM call can otherwise have ambiguous external effects. A synced or missing lead cannot be retried. Metadata refresh is a read and uses its existing cache lease.

Social sends and workflow commands have no blind retry control. Resolve an unknown message only after confirming its actual state in Instagram through the conversation's existing recovery flow. Notification retry is automatic and bounded; the console never replays a stale incident notification. Inspect its persisted receipt and correct the notification destination. The incident detail shows recorded opening, most recent occurrence and resolution timestamps, rather than reconstructing intermediate history that was never stored.

## Prometheus

Scrape the authenticated `/metrics` endpoint using a metrics credential. Metrics have bounded labels (role, kind, status, class and event type/result), with no tenant, account or participant labels. Database gauges measure the complete installation at scrape time; native Instagram counters are per API process, so aggregate `rate()` over API instances when graphing deliveries/events. Native delivery outcomes distinguish accepted, ignored, rejected, invalid and storage errors. Native event outcomes distinguish new acceptance from duplicate acceptance and rejection.

Load `deploy/monitoring/alerts.yml` in Prometheus. It covers missing/stale/degraded roles, accepted-event routing delay, configured destination delivery delay/dead letters and unknown sends requiring review. Unconfigured optional destinations are excluded from queue alerts. Role alerts apply only to the roles required for that target. The API-unavailable rule also covers failed scrapes and an entirely absent target list, so stopping the API or removing its target cannot silently suppress pipeline alerts. A resolved alert is sent after a detected failure recovers; this does not send startup announcements for services that have never failed.

Validate rules and the disabled-destination test fixture:

```sh
promtool check rules deploy/monitoring/alerts.yml
promtool test rules deploy/monitoring/alerts.test.yml
```

For an isolated local verification, point `DATABASE_ADMIN_URL` at an administrative PostgreSQL database and run:

```sh
npm run typecheck
npx vitest run tests/integration/operations.test.ts
```

The test helper creates and drops its own database and migrations. It never seeds the working application. Tests cover tenant boundaries, payload exclusion, generation fencing, factual incident history, optional destinations, stale/missing/degraded/fresh service observations and replacement replicas.

## Run the external monitor

This stack is independent of the API, worker, relay, database and Temporal. It reads the actual API metrics; it does not create application replicas, seed rows or simulate successful sends. Start it on a separate host for host-failure detection. Running it on the same laptop detects application/process failures while Docker and the laptop are running; it cannot notify when that laptop loses power or networking. Monitor the monitor itself from an independent system if that failure must page someone.

Create `.local/monitoring/metrics.token` containing the existing monitoring bearer token as one line. Use the token whose SHA-256 digest is configured as the API's `METRICS_TOKEN_HASH`; an operator session token will not work. Keep its directory private and do not commit it. The Compose secret mounts this file read-only at `/run/secrets/metrics_token`; the token is absent from Compose environment values and Prometheus YAML. Compose's local file-backed secrets are filesystem mounts, not an encrypted secret store. Keep `.local/monitoring` at mode `700`; individual mounted files use mode `644` so the containers' unprivileged `nobody` user can read them, while other host users cannot traverse the private directory.

The default target is the actual host API at `host.docker.internal:3000`. For another port, create `.local/monitoring/targets.yml`:

```yaml
- targets: ['host.docker.internal:3100']
```

Then export `MONITORING_TARGETS_FILE=./.local/monitoring/targets.yml`. The API must listen on an interface reachable from the container (configure `HOST` accordingly); test connectivity in the Prometheus Targets page. For a remote deployment, use its actual host/port and set `labels: {__scheme__: https}` in that target entry. TLS verification stays enabled.

For a workspace created by quickstart, run `npm run monitoring:init` to provision its metrics credential without printing it. From the repository root, start Prometheus with `docker compose -f compose.monitoring.yaml up -d prometheus`. A custom deployment can provision the same file manually:

```sh
mkdir -p .local/monitoring
chmod 700 .local/monitoring
# Place your monitoring token in .local/monitoring/metrics.token using your secret manager.
chmod 644 .local/monitoring/metrics.token
docker compose -f compose.monitoring.yaml up -d prometheus
```

Open `http://127.0.0.1:9090/targets` and confirm the real target is `UP`, then inspect `/alerts`. The UI binds to loopback. Default operation has an empty Alertmanager discovery file, and no messages go to any recipient. Prometheus keeps 15 days of data in its own named volume. To store the measurements on the host, set `MONITORING_DATA_VOLUME` to a dedicated writable directory inside a private parent and reuse that setting when recreating the container. A missing/wrong token or unreachable API causes a real scrape failure and the API-unavailable alert after one minute; it does not become a green placeholder.

### Enable Telegram for one selected operator

Choose the receiving chat explicitly. The operator must start the bot (or add it to the chosen group). Use the numeric chat ID and a bot token file provided through your secret manager; neither goes into tracked configuration. This is a separate external service alert channel from the application's tenant incident notifications. A dedicated bot prevents their Telegram rate limits from interfering.

Prepare the local configuration without sending anything:

```sh
./deploy/monitoring/enable-telegram.sh "$TELEGRAM_BOT_TOKEN_FILE" "$TELEGRAM_CHAT_ID"
```

Then explicitly enable delivery:

```sh
docker compose --env-file .local/monitoring/telegram.env -f compose.monitoring.yaml --profile telegram up -d
```

This starts Alertmanager and changes Prometheus discovery to `alertmanager:9093`. It groups related alerts, sends failures and recovery messages, and repeats still-active alerts every four hours. The Telegram token is read from a mounted secret file. Only alert names and fixed summaries are sent; no message bodies, emails, tenant IDs or credentials enter notifications. The numeric chat ID is in the private generated Alertmanager config. Configuration parsing never delivers a test Telegram message.

To disable outbound notifications and return to standalone monitoring:

```sh
docker compose --env-file .local/monitoring/telegram.env -f compose.monitoring.yaml --profile telegram stop alertmanager
docker compose -f compose.monitoring.yaml up -d --force-recreate prometheus
```

To stop the independent stack, retain the data volumes:

```sh
docker compose --env-file .local/monitoring/telegram.env -f compose.monitoring.yaml --profile telegram down
```

Omit `--env-file` and `--profile telegram` if Telegram was never configured.

## CI configuration validation

Run from the repository root on a Docker-enabled runner:

```sh
./deploy/monitoring/check.sh
docker compose -f compose.monitoring.yaml config --quiet
docker compose -f compose.monitoring.yaml --profile telegram config --quiet
```

`check.sh` uses the same pinned images as Compose and runs `promtool check config`, `promtool test rules`, and `amtool check-config` for both disabled and Telegram configurations. It uses temporary isolated syntax-only credentials and network-disabled containers, then removes the temporary files. Rule tests cover configured versus disabled destinations, missing role observations, absent API targets, actual scrape failures and recovery, unknown sends, and isolation between API targets and unrelated scrape jobs. A bounded temporary filesystem allows rule tests without writing to the Docker disk. Pull the pinned images before running these commands on an offline runner.

Configuration references: [Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) and [Alertmanager Telegram receiver](https://prometheus.io/docs/alerting/latest/configuration/#telegram_config).

### Delivery expectations without API secrets

On an API deployment, set `EXPECTED_DELIVERIES=crm,alerts,metadata` to require those consumers even when their credentials exist only on relay deployments. Choose only the consumers this installation actually needs. Values are optional, unique and validated; unknown names, empty list items and duplicates fail startup. An empty value adds no expectations. Credentials configured directly on an API still imply their existing expectations.

This setting contains no credentials and never starts a consumer or advertises an observed capability, including with `ROLE=all`. Relay heartbeats advertise only services that actually started from their own integration configuration. If a CRM-capable replica stops or its observation expires while a relay without CRM remains healthy, an API expecting `crm` reports `attention`, retains `configured: true` and `observed: false` for that queue, disables retry and keeps CRM lag/dead-letter alerts enabled. With no explicit expectation, a newly observed optional destination is visible while its relay is fresh, but does not establish a permanent deployment requirement.
