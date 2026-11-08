# Instagram comment automations

A workspace for publishing rules that turn Instagram comments into conversations. An operator chooses a keyword, writes the public reply and private question, then specifies the link to send after the person replies with an email address.

The console opens on the rules owned by the signed-in workspace. A new installation has no connected accounts, rules, conversations or leads. An operator can save a draft immediately. Publication requires a verified account with messaging permissions and configured delivery workers.

## Run the workspace

Install Node 24+ and start Docker with Compose. From a new checkout on macOS or Linux, run:

```sh
git clone https://github.com/Psy-Labs-admin/blotato-comment-automation.git
cd blotato-comment-automation
npm run quickstart
```

The launcher installs the locked dependencies, starts a private local PostgreSQL instance, applies migrations and opens your empty workspace using a single-use sign-in link. Save a draft and restart the command to pick up where you left off. Ctrl+C stops the API. The database persists across restarts. Docker Desktop on macOS stores the data in this checkout’s private local directory. Linux uses a named Docker volume. To sign in again while the API is running, use `node scripts/admin.cjs open`. For a headless machine, use `npm run quickstart -- --no-open`.

If a dedicated local PostgreSQL database already exists, supply its loopback `DATABASE_URL` on the first launch. The launcher binds that installation to its database. The operator credentials and service environment are stored under `.local/operator/` with owner-only permissions.

For a public HTTPS deployment, see [the deployment instructions](docs/instagram.md#deploy-a-public-callback-host).

The API-only installation supports authenticated inspection, draft creation and editing. To connect a professional Instagram account and turn on actual delivery, follow [Instagram setup](docs/instagram.md). PostgreSQL stores the workspace. Temporal is required for workers and relay processes.

## Operator workflow

1. In **Automations**, choose **Create automation**. Enter a name and save the draft. Changes persist across sessions.
2. In **Accounts**, connect an Instagram professional account through Meta. The service verifies the account and subscribes to comments and messages before allowing publication.
3. Complete the keyword, reply copy and link. Choose the verified account and publish. Running conversations retain their original published version.
4. In **Conversations**, review incoming activity. If the platform's acknowledgement was lost, inspect the message history before authorizing another attempt.
5. In **Operations**, review incidents and delivery history. Open a stopped CRM or metadata delivery, fix its destination and enter a reason to retry. Notification diagnostics show the most recent recorded outcome.

## Architecture

PostgreSQL records incoming events, conversation ownership, immutable rule versions, send attempts and leads. Unique constraints and row locks prevent duplicate runs and competing replies. Temporal drives execution, deadlines and recovery. The transactional outbox delivers workflow commands and configured integrations independently.

A durable send reservation records the attempt before the external call. A dropped acknowledgement leaves the attempt uncertain. A worker can resume after restart without blindly sending the message again. The pricing link goes back to the person in their Instagram conversation. The collected email is format-checked and recorded for the workspace.

- [Architecture, data model and execution](docs/design.md)
- [Why the external send needs a ledger](docs/decisions/002-external-send-guarantees.md)
- [Operations and recovery](docs/operations.md)
- [Worker upgrades and history replay](docs/worker-upgrades.md)
- [Monitoring, alert rules and recovery](docs/monitoring.md)
- [Telegram configuration and delivery checks](docs/telegram.md)
- [Tracing and the load test](docs/observability.md)
- [Human and AI contributions](AI_USAGE.md)

## Verify

From the same checkout, run:

```sh
npm run verify
```

This command starts isolated test infrastructure, exercises a real browser, measures the server and Temporal workflow separately, restarts a fresh workspace and checks duplicate traffic through completion. It requires no provider accounts. Open `coverage/index.html` to inspect uncovered code and `reports/acceptance/load.json` for event, send and completion counts. To use an existing local PostgreSQL server for testing, set `DATABASE_ADMIN_URL` to an account that can create and drop disposable databases.

[Scenario coverage and test commands](docs/testing.md) · [GitHub verification runs and downloadable reports](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/checks.yml)
