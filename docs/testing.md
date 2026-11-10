# Verification

From the repository root, use Node 24+, macOS or Linux, and running Docker.

```sh
npm run verify
```

The runner installs locked dependencies, Chromium and Temporal's development server, then creates temporary loopback PostgreSQL and isolated test databases. To supply local Postgres, set `DATABASE_ADMIN_URL` to a loopback administrator with database-creation rights, without query parameters/fragments. Workspace keys and provider settings stay separate.

Start with duplicate DMs and replies that go unanswered.

- [Duplicates](../tests/failure-scenarios/duplicates.test.ts) sends one comment five times concurrently, expecting one run and three messages.
- [Races](../tests/failure-scenarios/races.test.ts) covers replies during question delivery, simultaneous emails and deadline boundaries.
- [Lost acknowledgements](../tests/failure-scenarios/crash-and-unknown.test.ts) checks a crash after acceptance and human review when provider confirmation fails.
- [Restart](../tests/failure-scenarios/restart.test.ts) preserves answers and deadlines across downtime.
- [Credential generations](../tests/integration/instagram-send-generation.test.ts) protects newer tokens from old unauthorized responses.
- [API behavior](../tests/integration/public-api.test.ts) checks revisions, tenant boundaries and tied-timestamp pagination. [Contract validation](../tests/integration/openapi-contract.test.ts) checks payloads for every documented operation.

## Reports

Read `reports/acceptance/checks.json` for stages/outcomes and `load.json` alongside it for duplicates, completions, latency and pending work. Individual cases appear in `reports/tests.xml` and `reports/browser.xml`.

`coverage/index.html` shows coverage. [Independent floors](../tests/coverage-policy.json) cover server, Temporal and Chromium execution. Missing workflow/browser captures fail verification. CLI startup gaps stay visible. The launcher check starts and restarts a fresh workspace. [CI artifacts](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/checks.yml) include container and monitoring checks.

## Repeat one check

Install dependencies, build and set `DATABASE_ADMIN_URL` to a disposable test administrator.

```sh
npm test -- tests/failure-scenarios
npm test -- tests/integration/public-api.test.ts
npm run test:browser
node scripts/workspace-smoke.cjs
```

To watch a browser test, run `npx playwright install chromium` once, then `npm run test:browser -- --headed`. The verifier installs only the headless shell. Tests use real PostgreSQL, HTTP and Temporal with controlled providers. Live delivery requires configured [Instagram accounts](instagram.md) and [Telegram checks](telegram.md).
