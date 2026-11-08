
# Verification

Run `npm run verify` from the repository root on macOS or Linux with Node 24+ and Docker running. The first invocation downloads npm dependencies, Chromium and the Temporal development server. The verifier creates its own temporary PostgreSQL container on loopback. Alternatively, supply a local `DATABASE_ADMIN_URL` with permission to create databases. Each test suite owns and drops its databases. The workspace, its authorization keys and provider settings are separate.

| Risk or operator task | Executable evidence |
|---|---|
| Duplicate comments, early replies, simultaneous valid emails, conflicting rules | [Duplicates](../tests/failure-scenarios/duplicates.test.ts), [races](../tests/failure-scenarios/races.test.ts), [routing](../tests/integration/routing.test.ts), [waits](../tests/integration/waits.test.ts) |
| Restart while waiting, lost acknowledgement, operator recovery, opt-out or cancelled conversation | [Restart](../tests/failure-scenarios/restart.test.ts), [ambiguous sends](../tests/failure-scenarios/crash-and-unknown.test.ts), [stops](../tests/failure-scenarios/cancel-and-stop.test.ts), [send ledger](../tests/integration/send-ledger.test.ts) |
| Replay recorded history, rollover, deploy different worker versions | [Replay](../tests/integration/replay.test.ts), [rollover](../tests/integration/rollover.test.ts), [worker versioning](../tests/integration/worker-versioning.test.ts) |
| Webhook forgery, signed duplicates, revoked credentials, stale OAuth callbacks, reconnect/disconnect, complete native conversation | [Webhook](../tests/integration/instagram-webhook.test.ts), [OAuth](../tests/integration/instagram-oauth.test.ts), [send generation](../tests/integration/instagram-send-generation.test.ts), [native journey](../tests/integration/native-journey.test.ts) |
| Delivery lag, missing/expired/unhealthy/replacement workers, unsafe retries, two operators retrying the same job, tenant isolation | [Operations](../tests/integration/operations.test.ts), [concurrent recovery](../tests/integration/dead-letter-races.test.ts), [real service processes](../tests/integration/role-health.test.ts), [access](../tests/integration/access.test.ts), [alert rules](../deploy/monitoring/alerts.test.yml) |
| Telegram rejection in an HTTP 200, burst throttling, expired permission, ambiguous acceptance, crash around acknowledgement, obsolete recovery, competing relays | [Telegram response contract](../tests/unit/telegram.test.ts), [durable delivery](../tests/integration/alert-delivery.test.ts) |
| Browser login, draft persistence, first-use and populated layouts, incident history, retry, filters, pagination and notification diagnostics | [Chromium journeys](../tests/browser/operations.spec.ts), [session security](../tests/integration/session.test.ts) |
| Fresh installation, cookie/CSRF authorization, restart with saved draft and session, absence of seeded or external activity | [Release launcher check](../scripts/workspace-smoke.cjs) |
| Accepted traffic through to final send, CRM completion, empty queue, duplicate requests under load | [HTTP load check](../tests/load/load-check.ts), [methodology and larger run](observability.md) |

## Reports

`coverage/index.html` shows executable source lines and branches. `coverage/lcov.info` is suitable for coverage tools. The CI run summary breaks down server TypeScript, the workflow running in a Temporal isolate, and browser JavaScript running in Chromium. The [per-runtime floors](../tests/coverage-policy.json) are enforced independently. A missing workflow or browser capture fails the build. Uncovered CLI and process startup paths stay visible in the server report. The separate process restart check verifies the compiled launcher, but does not add its executions to the server percentage. Chromium branches are execution ranges. Styles, migrations and shell scripts are verified by their functional checks and are outside these source percentages.

`reports/tests.xml` and `reports/browser.xml` list the individual Vitest and Chromium cases. `reports/acceptance/checks.json` lists the executed stages, durations and outcomes. `reports/acceptance/load.json` records traffic, duplicates, loss, latency, completions and final pending work. Each push and pull request starts and restarts the default Docker-backed workspace, then checks the production container and evaluates the Prometheus and Alertmanager configurations. Download the reports from the [GitHub Actions run](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/checks.yml).

## Repeat one check

After installing dependencies and building, point `DATABASE_ADMIN_URL` at a disposable local test administrator and run the relevant command.

```sh
npm test -- tests/failure-scenarios
npm test -- tests/integration/operations.test.ts tests/integration/alert-delivery.test.ts
npm run test:browser
node scripts/workspace-smoke.cjs
sh deploy/monitoring/check.sh
```

Browser failures can be investigated with `npm run test:browser -- --headed`. The tests use real PostgreSQL, HTTP and Temporal. Instagram, CRM and Telegram provider responses are controlled only inside the tests so failures can be reproduced. Verifying a real comment or Telegram delivery requires an authorized account or a configured bot and operator chat. See the [Instagram connection guide](instagram.md) and [Telegram channel check](telegram.md).
