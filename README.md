# Instagram comment automations

A workspace for publishing rules that turn Instagram comments into conversations. An operator chooses a keyword, writes the public reply and private question, then specifies the link to send after the person replies with an email address.

The console opens on the rules owned by the signed-in workspace. A new installation has no connected accounts, rules, conversations or leads. An operator can save a draft immediately. Publication requires a verified account with messaging permissions and configured delivery workers.

## Run the workspace

Use Node 24 or later and a PostgreSQL database owned by the application role. From the repository root:

```sh
npm ci
npm run build
# Set DATABASE_URL in the environment to this installation's PostgreSQL database.
node scripts/admin.cjs init 'My workspace'
node --env-file=.local/operator/service.env dist/main.js
```

In a second terminal, run `node scripts/admin.cjs open`. This opens a short-lived, single-use sign-in link in your browser. The bootstrap stores local credentials under `.local/operator/` with owner-only permissions. Re-running it for the same installation keeps existing credentials and configuration. An organization can instead provide tenant-bound operator token hashes and secrets through its deployment environment.

For a public HTTPS deployment, see [the deployment instructions](docs/instagram.md#deploy-a-public-callback-host).

The API-only installation supports authenticated inspection, draft creation and editing. To connect a professional Instagram account and turn on actual delivery, follow [Instagram setup](docs/instagram.md). PostgreSQL stores the workspace. Temporal is required for workers and relay processes.

## Operator workflow

1. In **Automations**, choose **Create automation**. Enter a name and save the draft. Changes persist across sessions.
2. In **Accounts**, connect an Instagram professional account through Meta. The service verifies the account and subscribes to comments and messages before allowing publication.
3. Complete the keyword, reply copy and link. Choose the verified account and publish. Running conversations retain their original published version.
4. In **Conversations**, review incoming activity. If the platform's acknowledgement was lost, inspect the message history before authorizing another attempt.

## Architecture

PostgreSQL records incoming events, conversation ownership, immutable rule versions, send attempts and leads. Unique constraints and row locks prevent duplicate runs and competing replies. Temporal drives execution, deadlines and recovery. The transactional outbox delivers workflow commands and configured integrations independently.

A durable send reservation records the attempt before the external call. A dropped acknowledgement leaves the attempt uncertain. A worker can resume after restart without blindly sending the message again. The pricing link goes back to the person in their Instagram conversation. The collected email is format-checked and recorded for the workspace.

- [Architecture, data model and execution](docs/design.md)
- [Why the external send needs a ledger](docs/decisions/002-external-send-guarantees.md)
- [Operations and recovery](docs/operations.md)
- [Worker upgrades and history replay](docs/worker-upgrades.md)
- [Tracing and the load test](docs/observability.md)
- [Human and AI contributions](AI_USAGE.md)

## Verify

```sh
npm run typecheck
npm run build
DATABASE_ADMIN_URL=postgres://localhost/postgres npm test
```

The PostgreSQL test user must be able to create disposable databases. The suite starts a separate Temporal development server by default. Isolated tests exercise duplicate comments, competing inputs, restart, lost acknowledgements, tenant isolation and provider failures. Test fixtures are excluded from the application build. Contract tests for Instagram use recorded-format HTTP inputs and local transports. A live Meta round trip requires an authorized application and account.
