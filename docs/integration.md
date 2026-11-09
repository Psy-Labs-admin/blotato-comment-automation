# Connect your application

Use the HTTP API from a backend you control. A customer admin can create and publish rules, show run progress and display collected leads. A reporting application can use a read-only key. The account owner connects Instagram in the Blotato console.

[Public Swagger reference](https://psy-labs-admin.github.io/blotato-comment-automation/) · [OpenAPI 3.1 file](../src/api/openapi.json) · [Runnable Node.js example](../examples/external-admin.mjs)

## First request

Start the service with `npm run quickstart`. In a second terminal in the same checkout:

```sh
export BLOTATO_API_KEY="$(npm run --silent api:key -- create reporting)"
export BLOTATO_API_URL=http://127.0.0.1:3000/api/v1
curl --fail-with-body -sS -H "Authorization: Bearer $BLOTATO_API_KEY" "$BLOTATO_API_URL/workspace"
node examples/external-admin.mjs
```

Use the port printed at startup. The response contains `id` and `name` for your installation. A new workspace returns an empty accounts list and empty pages of runs and leads. No provider credentials are needed to reach this point.

**Swagger UI.** Open `/docs/` on your running service, choose **Authorize**, and enter the key value. Select **Workspace → GET /workspace → Try it out → Execute**. The explorer sends requests to the same service and keeps authorization in page memory. Reloading clears it. The public reference is for browsing. Import `GET /openapi.json` from your installation into Postman or Insomnia, or use it as input for a generated client.

## Credentials and deployment

| Key scope | Authority within one workspace |
|---|---|
| `read`, the default | Read workspace identity, account readiness, drafts, published rules, runs, timelines and leads, including captured email addresses. |
| `write` | All reads, plus creating/editing drafts, publishing them, and enabling or disabling published rules. |

An installation administrator runs `api:key` on a trusted host. Quickstart resolves the database and workspace from its private local installation files. For a managed deployment set **both** `DATABASE_URL` and `BLOTATO_TENANT_ID` for the administrative CLI. The API service must have applied its migrations. In a deployed image the same CLI is available as `node scripts/api-key.cjs`.

```sh
npm run --silent api:key -- list
npm run --silent api:key -- create "Customer dashboard" --write
npm run --silent api:key -- revoke <key-id-from-list>
```

Creation writes the new token to standard output once and its management ID to standard error. Store the key in your backend secret store. Listing returns management IDs, labels, scopes and status. To rotate, issue a second key, deploy it to the client, check `GET /workspace` and revoke the old ID. Revocation takes effect on subsequent requests across API replicas.

A key identifies its workspace. Use your product’s own session and permissions for end users. Browser UI code calls your backend, which holds the Blotato key. The Blotato console uses a separate operator login, and inbound platform events use their own signatures. The machine API accepts integration Bearer keys. Configure the deployed HTTPS origin as the base URL, ending in `/api/v1`.

## Build and publish a rule

These examples use a POSIX shell, curl and jq. The Node example above requires only Node 24. This walkthrough creates a real draft in the selected installation.

```sh
export BLOTATO_API_KEY="$(npm run --silent api:key -- create 'Rule editor' --write)"
api() { curl --fail-with-body -sS -H "Authorization: Bearer $BLOTATO_API_KEY" -H 'Content-Type: application/json' "$@"; }

draft=$(api -X POST "$BLOTATO_API_URL/drafts" --data '{"name":"Pricing replies"}')
draft_id=$(printf '%s' "$draft" | jq -er '.draft.id')
revision=$(printf '%s' "$draft" | jq -er '.draft.revision')
```

Set the keyword, the public reply, the private question and the link. Replace the example destination and copy with the values you intend to send. Supplying `content` replaces the whole content object. Omitting `content` preserves it.

```sh
draft=$(api -X PATCH "$BLOTATO_API_URL/drafts/$draft_id" --data "$(jq -n --argjson rev "$revision" '{
  expectedRevision: $rev,
  content: {
    keyword: "pricing",
    publicReply: "I will send the details in a private message.",
    emailPrompt: "Which email should I record for this request?",
    linkText: "Here is the pricing page.",
    linkUrl: "https://example.org/pricing",
    timeoutHours: 72,
    maxClarifications: 0
  }
}')")
revision=$(printf '%s' "$draft" | jq -er '.draft.revision')
api "$BLOTATO_API_URL/accounts" | jq '.accounts[] | {id,displayName,canPublish,issue}'
```

**An API-only installation can stop here.** Reopen the draft in the console or call `GET /drafts/{id}`. To publish, use the internal account `id` of a verified, publishable account from the list. Choose the intended account explicitly. Its `accountId` is the Instagram identifier and serves a different purpose. The console and [Instagram setup](instagram.md) explain how to connect the account and enable processing.

```sh
# Set CONNECTION_ID to the account's internal id before continuing.
draft=$(api -X PATCH "$BLOTATO_API_URL/drafts/$draft_id" \
  --data "$(jq -n --arg id "${CONNECTION_ID:?Select an account first}" --argjson rev "$revision" '{connectionId:$id,expectedRevision:$rev}')")
revision=$(printf '%s' "$draft" | jq -er '.draft.revision')
api -X POST "$BLOTATO_API_URL/drafts/$draft_id/publish" \
  --data "$(jq -n --argjson rev "$revision" '{expectedRevision:$rev}')"
```

Publication returns the draft, a published `automationId`, immutable `versionId` and numeric `version`. Use the draft ID for further edits and the automation ID for `/automations/{id}/disable` or `/enable`. Disabling controls future matches; active conversations retain the rule version with which they started.

## Read conversations and leads

- **List runs** with `GET /runs?limit=25`. Add `status=waiting_input` or `needsReview=true` for conversations that need attention. A run belongs to a conversation; its `id` selects a single execution.
- **Inspect a run** with `GET /runs/{id}` and `GET /runs/{id}/timeline`. Timeline entries report recorded decisions and provider acknowledgements. A provider acceptance does not establish that the recipient read the message.
- **Read captured leads** with `GET /leads?limit=25`. Each lead has its own ID, captured email, run and conversation IDs, creation time and CRM status. An email is format-checked at collection. A configured CRM may also receive a lead through the outbox. Use the lead ID to upsert records in your own system.
- **Read multiple pages** by passing the returned `nextCursor` as `cursor` with the same filters until it is `null`. Collections of drafts, published rules, runs and leads are newest first. The default page size is 25 and the maximum is 100. A cursor is a workspace-scoped item ID. A new traversal includes records created since your previous traversal. The read API returns current state; it does not provide a change stream.

## Conflicts and retries

| Response | Client action |
|---|---|
| `400` | Correct the body, ID, query, cursor or invalid rule definition. Use the OpenAPI schema for limits and required fields. |
| `401` | Check the Bearer integration key and its revocation status. |
| `403` | Use a write key for mutations. Any supplied workspace header must agree with the key. |
| `404` | Verify the resource type, ID and workspace. A draft and its published rule have separate IDs. |
| `409 revision_conflict` | Fetch the latest draft, merge the user's changes, and submit its current revision. |
| Other `409` | Read the account's `issue` and the error body. Publication requires a publishable connected account and configured dispatch. |
| Network failure or `5xx` | Retry reads with bounded backoff. Confirm the effect of a write before deciding whether to repeat it. |

Draft creation has no idempotency key. If its response is lost, check drafts before creating another. Draft edits require the last observed `expectedRevision`; a committed edit advances the revision. Repeating a successful publish at the same revision returns the existing version. A read key or a key from another workspace cannot be used to retry a write.

The versioned API has no built-in per-key request quota. A deployment can enforce client traffic limits at its HTTPS proxy. Instagram send windows and delivery budgets are enforced separately in the workflow.

## Verify the client

Run `npm run verify` for server scenarios, browser interaction, measured coverage and release acceptance. The suite checks the OpenAPI schema, actual response shapes, key scopes and revocation, cross-workspace boundaries, draft conflicts and pagination. Each test uses an isolated environment. [Verification guide](testing.md)
