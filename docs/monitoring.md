# Monitoring and recovery

`/live` checks the process, `/health` the database and `/ready` the configured pipeline. An API-only workspace reports dispatch as `disabled`. If a live conversation stalls, check both readiness and the age of the oldest queued job.

Workers check SDK state and Temporal. Relays check Temporal and destination drain cycles. Each replica checks in every 10 seconds. After 45 seconds of silence, we treat it as gone. One healthy replacement keeps the role available during a rollout.

Open **Operations** for this workspace’s queues, incidents and delivery receipts. If you haven’t set up a destination yet, its jobs stay queued.

### Delivery expectations without API secrets

Set `EXPECTED_DELIVERIES=crm,alerts,metadata` on the API when those consumers are required but their credentials live only on relays. Pick the kinds you need. Empty values add no expectations. Unknown names, duplicates and empty list items fail startup. API-side credentials also imply expectations.

Relays advertise services they actually started. A missing expected consumer fails readiness, blocks retry and keeps queue alerts active even if another relay is healthy.

## Recovery

Fix the destination, then retry stopped CRM or metadata deliveries through **Operations** using the current generation and an operator reason. [The operator request](operations.md#crm_delivery_failing) locks the row, advances its generation and records an audit event together. Stale requests return 409. A healthy matching consumer and applicable target are required. Synced or missing leads cannot retry.

The original idempotency key survives retry. The CRM must honor it because a timed-out call may have taken effect. Metadata refresh uses its cache lease. Confirm uncertain social sends in Instagram before [resolving their intents](operations.md#incident-playbooks). Notifications retry automatically with a limit. Inspect receipts and fix the channel when they stop.

## Prometheus

Scrape `/metrics` with the token matching `METRICS_TOKEN_HASH`. Database gauges cover the whole installation. To measure native Instagram traffic, sum the counter rates across your API replicas.

Load [alerts.yml](../deploy/monitoring/alerts.yml). [Operations lists its thresholds](operations.md#signals-to-watch). Optional unconfigured destinations are excluded. API alerts cover both failed scrapes and an absent target list. Recovery notifications follow detected failures.

## Run the external monitor

Use another host to detect application-host failure, and an independent system to page on monitor failure.

For a quickstart workspace, provision its existing metrics credential without printing it.

```sh
npm run monitoring:init
```

For custom deployments, put the monitoring token on one line in `.local/monitoring/metrics.token` through your secret manager.

```sh
mkdir -p .local/monitoring
chmod 700 .local/monitoring
# Provision metrics.token before continuing.
chmod 644 .local/monitoring/metrics.token
docker compose -f compose.monitoring.yaml up -d prometheus
```

The private parent protects files readable by the container's `nobody` user. Compose mounts the token read-only at `/run/secrets/metrics_token`. Protect these file-backed secrets on the host.

The default scrape target is `host.docker.internal:3000`. For another port, create `.local/monitoring/targets.yml`.

```yaml
- targets: ['host.docker.internal:3100']
```

Export `MONITORING_TARGETS_FILE=./.local/monitoring/targets.yml` before starting Compose. Set API `HOST` to a container-reachable interface. For a remote target, use its host/port and add `labels: {__scheme__: https}` to the entry. TLS verification stays enabled.

At `http://127.0.0.1:9090/targets`, confirm `UP`, then check `/alerts`. Default operation has no recipient. The loopback UI keeps metrics for 15 days in a named volume. For host storage, set and reuse `MONITORING_DATA_VOLUME` pointing to a dedicated writable directory inside a private parent.

### Enable Telegram for one selected operator

This external service-alert channel is separate from [application incidents](telegram.md). Choose a chat, start the bot or add it to that group, and use a numeric chat ID. A dedicated bot keeps the channels' rate limits separate.

Prepare private configuration with a token file from your secret manager, then enable delivery.

```sh
./deploy/monitoring/enable-telegram.sh "$TELEGRAM_BOT_TOKEN_FILE" "$TELEGRAM_CHAT_ID"
docker compose --env-file .local/monitoring/telegram.env -f compose.monitoring.yaml --profile telegram up -d
```

Alertmanager groups failures, sends recoveries and repeats active alerts every four hours. Messages contain alert names and fixed summaries. Configuration checks send no test messages.

Disable outbound delivery and restore standalone Prometheus with these commands.

```sh
docker compose --env-file .local/monitoring/telegram.env -f compose.monitoring.yaml --profile telegram stop alertmanager
docker compose -f compose.monitoring.yaml up -d --force-recreate prometheus
```

Stop the stack while retaining volumes with the following command. Omit the env file and profile if Telegram was never configured.

```sh
docker compose --env-file .local/monitoring/telegram.env -f compose.monitoring.yaml --profile telegram down
```

## CI configuration validation

Run from the repository root with Docker available. Pull pinned images first for an offline runner.

```sh
./deploy/monitoring/check.sh
docker compose -f compose.monitoring.yaml config --quiet
docker compose -f compose.monitoring.yaml --profile telegram config --quiet
```

The script validates configuration and rules in network-disabled containers with temporary credentials. Local alternatives are `promtool check rules deploy/monitoring/alerts.yml` and `promtool test rules deploy/monitoring/alerts.test.yml`.

With `DATABASE_ADMIN_URL` pointing to an administrative database, `npx vitest run tests/integration/operations.test.ts` checks recovery fencing, tenant boundaries and role observations in a throwaway database.
