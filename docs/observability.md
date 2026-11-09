# Observability and load checks

## OpenTelemetry tracing

Point the API at an OTLP collector when you want traces. To try it with a local collector, run this.

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json \
npm start
```

`OTEL_EXPORTER_OTLP_ENDPOINT` also works and receives the `/v1/traces` suffix. The traces-specific endpoint takes precedence. `OTEL_SDK_DISABLED=true` disables export. Unsupported protocols fail startup.

A trace follows a request inside one process. It records the HTTP method, status and route group, plus fixed names for ingest, routing, activities and relay work. Once the job moves to another process, follow it in the run timeline.

Exports include fixed service metadata and generated trace/span IDs. Bodies, emails, customer IDs, headers, raw URLs, SQL and exception text are excluded. Errors retain their status. The batch processor exports every second with a 2,048-span queue and five-second timeout. A full queue drops diagnostic spans. Collector failures don't block webhook acknowledgement or workflow success. Shutdown flushes pending spans.

Verify OTLP JSON, parent relationships and sensitive-field exclusion against a local collector.

```sh
npm test -- tests/integration/tracing.test.ts
```

## Reproducible load check

Use Node 24 or later and a local PostgreSQL administrator allowed to create databases. The check creates an isolated API, Temporal dev server, task queue, loopback HTTP simulators and throwaway database. Cleanup drops that database.

```sh
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:55432/postgres \
npm run test:load
```

By default, it sends 1,000 comment deliveries at 100 per second, waits for active questions, then sends 1,000 email-message deliveries at that rate. Every fifth delivery duplicates the previous event. Expected totals are 800 conversations, 1,600 distinct events, 800 leads and 2,400 provider sends. The raised send budget belongs only to this fixture.

Traffic enters `/webhooks/instagram` and exercises the normal pipeline. Startup is outside measurement. The generator shares the application process and dispatches on a fixed cadence with concurrent requests.

| Report field | What it measures |
|---|---|
| `dispatchDeliveriesPerSecond` | Actual dispatch rate per phase |
| `httpAcknowledgementP95Ms` | Dispatch through parsed HTTP 202 response |
| `scheduledToAcknowledgementP95Ms` | Scheduled time through response |
| `generatorScheduleLagP95Ms` | Scheduled time through actual dispatch |
| `emailReceiptToRunCompletionP95Ms` | Persisted email receipt through completed run |
| `loss` | Expected minus persisted distinct events |
| `runsCompleted`, `runsFailed`, `unfinishedRuns` | Outcomes after bounded drain |
| `actualProviderSends`, `acceptedSendIntents` | Simulator effects and send-ledger totals |
| `pendingOutbox` | Remaining commands and integration jobs |

Passing requires all expected completions, exact deduplication, zero loss, matching send totals and an empty outbox. Failure exits nonzero. If scheduling lag climbs, the traffic generator itself is falling behind. Run this on your target hardware before using the numbers to size a deployment.

```sh
LOAD_RATE=25 LOAD_DELIVERIES=50 npm run test:load
LOAD_REPORT_PATH=/tmp/blotato-load.json npm run test:load
```

`LOAD_DRAIN_TIMEOUT_MS` defaults to 120,000 per phase. Default traffic lasts ten seconds per phase, followed by drain time within that limit.
