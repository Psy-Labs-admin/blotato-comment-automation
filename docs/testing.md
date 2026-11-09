# Verification

Run the full check from the repository root with Node 24+, macOS or Linux, and Docker running.

```sh
npm run verify
```

The runner installs locked dependencies, Chromium and the Temporal development server. It creates temporary loopback PostgreSQL and isolated test databases. To use your own local Postgres, set `DATABASE_ADMIN_URL` to a loopback address with database-creation rights. Leave off query parameters and fragments. Workspace keys and provider settings are separate from the test environment.

Start with the two things most likely to annoy someone on Instagram — getting the same DM twice, or replying and hearing nothing back.

- [Duplicates](../tests/failure-scenarios/duplicates.test.ts) delivers one comment five times concurrently and checks one run and three messages.
- [Races](../tests/failure-scenarios/races.test.ts) checks an email arriving during the question send, two simultaneous emails and the deadline boundary.
- [Lost acknowledgements](../tests/failure-scenarios/crash-and-unknown.test.ts) checks a worker dying after provider acceptance. The worker holds the send for a human check when the provider can’t confirm what happened.
- [Restart](../tests/failure-scenarios/restart.test.ts) retains an answer while the worker is down and preserves the original deadline.
- [Credential generations](../tests/integration/instagram-send-generation.test.ts) prevents an old unauthorized response from revoking a newer token.
- [API behavior](../tests/integration/public-api.test.ts) checks stale revisions, tenant boundaries and pagination with tied timestamps. [Contract validation](../tests/integration/openapi-contract.test.ts) checks actual payloads for every documented operation.

## Reports

Open `reports/acceptance/checks.json` for stages and outcomes, and `load.json` in that directory for duplicate traffic, completions, latency and pending work. `reports/tests.xml` and `reports/browser.xml` identify individual cases.

`coverage/index.html` shows source coverage. [Independent floors](../tests/coverage-policy.json) cover server code, Temporal workflows and Chromium execution. Missing workflow or browser captures fail verification. CLI startup gaps remain visible. The launcher check starts a fresh workspace and restarts it.

[CI artifacts](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/checks.yml) also include container and monitoring checks.

## Repeat one check

After dependency installation and build, set `DATABASE_ADMIN_URL` to a disposable test administrator.

```sh
npm test -- tests/failure-scenarios
npm test -- tests/integration/public-api.test.ts
npm run test:browser
node scripts/workspace-smoke.cjs
```

Use `npm run test:browser -- --headed` to inspect browser failures. Tests use real PostgreSQL, HTTP and Temporal with controlled provider responses. Live delivery needs the configured accounts described in [Instagram setup](instagram.md) and [Telegram checks](telegram.md).
