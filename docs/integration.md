# Connect your application

Use a backend integration key. Your application can read runs and leads, or use a write key to manage rules. The account owner connects Instagram in the Blotato console.

[Swagger reference](https://psy-labs-admin.github.io/blotato-comment-automation/) · [OpenAPI 3.1](../src/api/openapi.json) · [Node client](../examples/external-admin.mjs)

## First request

Run `npm run quickstart`. In another terminal in the same checkout, run the client with Node 24+.

```sh
export BLOTATO_API_KEY="$(npm run --silent api:key -- create reporting)"
export BLOTATO_API_URL=http://127.0.0.1:3000/api/v1
node examples/external-admin.mjs
```

If quickstart printed a different port, use that port above. A fresh workspace returns its identity and empty lists. For the same identity check over plain HTTP, run this in that terminal.

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $BLOTATO_API_KEY" "$BLOTATO_API_URL/workspace"
```

For interactive requests, open `/docs/` on the running service, choose **Authorize**, paste the key, then execute `GET /workspace`. Authorization stays in page memory until reload. The public reference is for browsing. Import your installation's `/openapi.json` into Postman, Insomnia or a client generator.

## Credentials and deployment

Keys default to `read`, including captured email addresses. `--write` adds draft creation, editing, publication and rule enable/disable. Keep keys in your backend secret store and enforce end-user permissions in your own application.

```sh
npm run --silent api:key -- list
npm run --silent api:key -- revoke <key-id-from-list>
```

Creation prints the token once to stdout and its management ID to stderr. Rotate by issuing a replacement, checking `GET /workspace` through your client, then revoking the old ID. Revocation applies to subsequent requests across replicas.

Quickstart resolves its private database and workspace settings. On a managed host, apply migrations and set both `DATABASE_URL` and `BLOTATO_TENANT_ID` for the administrator CLI. Container deployments can use `node scripts/api-key.cjs`. Set the client base URL to the deployed HTTPS origin plus `/api/v1`.

## Build and publish a rule

Create a draft with the same client, using a write key.

```sh
export BLOTATO_API_KEY="$(npm run --silent api:key -- create 'Rule editor' --write)"
node examples/external-admin.mjs --create-draft "Pricing replies"
```

The client returns `draftId` and `revision`. In local Swagger, authorize with this key and use `PATCH /drafts/{id}` to set the content. Swagger has a ready-to-edit request body. Keep the fields you want when sending `content`, because it replaces the whole object. For a name-only edit, a fresh draft takes `{"expectedRevision":1,"name":"Pricing replies v2"}`. Each save returns the revision to use on your next edit or publish.

An API-only installation can save drafts. Publication also needs configured dispatch and a verified, publishable connection. Follow [Instagram setup](instagram.md), then select the intended account from `GET /accounts`. Set `connectionId` to its internal `id`. The separate `accountId` is the Instagram identifier.

Publish through `POST /drafts/{id}/publish`. Keep the draft ID for edits and the returned `automationId` for enable/disable. Publication also returns immutable `versionId` and numeric `version`. Disabling stops future matches. Active conversations retain their starting version.

## Read conversations and leads

Use `GET /runs?limit=25`, optionally filtered by `status=waiting_input` or `needsReview=true`. Inspect `/runs/{id}` and `/runs/{id}/timeline` for decisions and provider acknowledgements. Acceptance does not establish that a recipient read the message.

`GET /leads` returns captured emails, run/conversation IDs and CRM status. Use the lead ID for downstream upserts. Email collection checks format.

Drafts, rules, runs and leads page newest first. Pass `nextCursor` as `cursor` with unchanged filters until null. The default limit is 25, maximum 100. Cursors are workspace-scoped item IDs. These reads show current state and provide no change stream.

## Conflicts and retries

For `409 revision_conflict`, fetch the draft, merge changes and retry with its current revision. Other publication conflicts can indicate account or dispatch readiness. Read the error body and account `issue`.

Retry reads with bounded backoff. Confirm a write's effect before repeating it. Draft creation has no idempotency key, so check existing drafts after a lost response. Repeating a successful publish at the same revision returns the existing version.

## Verify the client

[Verification](testing.md) covers response schemas, credential isolation, revision conflicts, pagination and the runnable client.
