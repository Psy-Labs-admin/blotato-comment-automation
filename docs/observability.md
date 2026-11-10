# Observability and load checks

## OpenTelemetry tracing

Enable tracing with an OTLP endpoint. For a local collector, run this.

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json \
npm start
```

Alternatively, set `OTEL_EXPORTER_OTLP_ENDPOINT`, which gets `/v1/traces` appended. The traces-specific endpoint wins. `OTEL_SDK_DISABLED=true` turns export off. Unsupported protocols stop startup.

Traces record HTTP method, status, route group and fixed ingest/routing/activity/relay names within one process. Follow cross-process work in the run timeline.

Exports include fixed service metadata and generated trace/span IDs. They exclude bodies, emails, customer IDs, headers, raw URLs, SQL and exception text. Errors keep their status. The batch processor exports every second, queues up to 2,048 spans and times out after five seconds. A full queue drops spans. Collector failures leave webhook acknowledgement and workflows running. Shutdown flushes pending spans.

Check OTLP JSON, parent relationships and sensitive-field exclusion.

```sh
npm test -- tests/integration/tracing.test.ts
```

## Reproducible load check

Use Node 24+ and a local PostgreSQL administrator with database-creation permission. The check starts an isolated API, Temporal dev server, task queue, loopback HTTP simulators and throwaway database, dropped during cleanup.

```sh
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:55432/postgres \
npm run test:load
```

Defaults send 1,000 comments at 100/sec, wait for questions, then 1,000 email messages at 100/sec. Every fifth delivery duplicates its predecessor. Expect 800 conversations, 1,600 distinct events, 800 leads and 2,400 provider sends. Only this fixture raises the send budget.

Traffic enters `/webhooks/instagram`. Startup is excluded. The in-process generator dispatches concurrent requests on a fixed cadence.

| Field | Read it as |
|---|---|
| `dispatchDeliveriesPerSecond` | Actual dispatch rate for each phase |
| `httpAcknowledgementP95Ms` | Dispatch to parsed HTTP 202 response |
| `scheduledToAcknowledgementP95Ms` | Scheduled send time to response |
| `generatorScheduleLagP95Ms` | How late the generator dispatched |
| `emailReceiptToRunCompletionP95Ms` | Persisted email receipt to finished run |
| `loss` | Expected distinct events minus persisted events |
| `runsCompleted`, `runsFailed`, `unfinishedRuns` | Run outcomes when drain time ends |
| `actualProviderSends`, `acceptedSendIntents` | Simulator effects and send-ledger totals |
| `pendingOutbox` | Commands and integration jobs still queued |

Passing requires expected completions, exact deduplication, zero loss, matching send totals and an empty outbox. Failure exits nonzero. Rising schedule lag means generator overload. Size using target hardware.

For smaller runs or saved reports, use these overrides.

```sh
LOAD_RATE=25 LOAD_DELIVERIES=50 npm run test:load
LOAD_REPORT_PATH=/tmp/blotato-load.json npm run test:load
```

`LOAD_DRAIN_TIMEOUT_MS` defaults to 120,000 per phase. Default dispatch takes ten seconds per phase, then drain time. Inspect unfinished work on timeout.
