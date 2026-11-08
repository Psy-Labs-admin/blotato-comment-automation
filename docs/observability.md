# Observability and load checks

## OpenTelemetry tracing

Tracing is disabled until an OTLP endpoint is explicitly configured. The default API starts no telemetry exporter and makes no telemetry network requests.

The implementation uses the official OpenTelemetry JavaScript SDK and OTLP HTTP JSON exporter. Set the collector endpoint when starting the application.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json \
npm start
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is also supported. Its base URL receives the `/v1/traces` suffix. A traces-specific endpoint takes precedence. `OTEL_SDK_DISABLED=true` disables export even when an endpoint exists. Unsupported protocol values fail at startup.

HTTP spans contain an allowlisted method, numeric response status and a fixed route group. Explicit operation spans use fixed names for ingestion, routing, activities and relay delivery. Nested operations share their request context through `AsyncLocalStorage`. Cross-process workflow execution is measured through the durable timeline and metrics. Trace context is confined to each process.

Exported data contains fixed service metadata and generated trace/span identifiers. Request bodies, message text, email addresses, customer identifiers, headers, raw URLs, SQL statements and exception text are excluded. Error spans retain the error status. Instrumentation deliberately uses a bounded allowlist of fields.

The batch processor exports every second, uses a queue of 2,048 spans and a five-second export timeout. A full queue drops diagnostic spans. Collector availability does not participate in webhook acknowledgement or workflow success. Application shutdown flushes pending spans through the SDK shutdown method.

The integration test starts a real local HTTP collector, verifies received OTLP JSON and HTTP → ingestion → routing parent/span relationships, and checks that sensitive sample values are absent.

```bash
npm test -- tests/integration/tracing.test.ts
```

The exporter endpoint rules and manual instrumentation follow the official OpenTelemetry documentation. [OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/), [JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/).

## Reproducible load check

The load check starts a separate HTTP API, Temporal dev server, task queue and HTTP simulators on ephemeral loopback ports. It creates and migrates a throwaway PostgreSQL database, then drops that database during cleanup. It leaves the operational workspace alone. `DATABASE_ADMIN_URL` must point to a local PostgreSQL administrator account with permission to create databases.

```bash
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:55432/postgres \
npm run test:load
```

Node 24 or later is required. A default run sends 1,000 comment deliveries at 100 deliveries per second, waits for the resulting questions to become active, then sends 1,000 email-message deliveries at the same rate. Every fifth delivery repeats the preceding event. This produces 800 conversations, 1,600 distinct inbox events, 800 leads and 2,400 provider sends. The account's business send budget is raised only inside this throwaway test fixture.

The API receives actual HTTP requests through `/webhooks/instagram`. The normal ingestion, routing, worker, send adapters, outbox relays, metadata hydration and CRM handlers process them. Infrastructure startup is outside the measured traffic phases. The generator and application share one Node process, and Temporal uses its development server.

The JSON report includes the following measurements.

| Field | Measurement |
|---|---|
| `dispatchDeliveriesPerSecond` | Actual rate across first and last HTTP request dispatch in each phase |
| `httpAcknowledgementP95Ms` | HTTP dispatch until the complete HTTP 202 response has been received and parsed |
| `scheduledToAcknowledgementP95Ms` | Intended dispatch time until that response, including delays inside the load generator |
| `generatorScheduleLagP95Ms` | Intended dispatch time until actual dispatch |
| `emailReceiptToRunCompletionP95Ms` | Persisted email event `received_at` until the associated run's `finished_at`, for completed runs |
| `loss` | Expected distinct inbox events minus persisted distinct events |
| `runsCompleted`, `runsFailed`, `unfinishedRuns` | Application outcomes after the bounded drain period |
| `actualProviderSends`, `acceptedSendIntents` | Simulator side effects compared with the send ledger |
| `pendingOutbox` | Undelivered commands and integration jobs at the end |

The report includes duplicates acknowledged in each phase, HTTP errors, routed events, lead and CRM counts, and whether all questions and jobs drained. A passing result requires all expected completions, exact deduplication, zero event loss, matching provider/ledger send counts and an empty outbox. Failure produces a nonzero exit code. The latency fields describe the measured operations separately from the person's response time.

The scheduler offers requests on a fixed cadence while earlier requests remain in flight. It records scheduling lag so overloaded generation remains visible in the result. Polling for drain happens after each traffic phase. The report measures one process against local infrastructure under the configured test fixture.

Settings can shorten a smoke check or save a report.

```bash
LOAD_RATE=25 LOAD_DELIVERIES=50 npm run test:load
LOAD_REPORT_PATH=/tmp/blotato-load.json npm run test:load
```

`LOAD_DRAIN_TIMEOUT_MS` defaults to 120,000 milliseconds per phase. The default test runs ten seconds of offered traffic per phase, followed by whatever drain time the system needs within that bound. Repeat measurements on the target infrastructure to assess its capacity.
