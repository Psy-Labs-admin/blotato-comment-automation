# Connect Instagram

Use **Instagram Login** with a professional account and its app ID and secret. **Unified Login** configuration IDs belong to Facebook Login for Business.

## Before enabling a workspace

1. Configure Instagram Login in the [Meta App Dashboard](https://developers.facebook.com/apps/). Test with an eligible professional account and required app role. Get access and approvals before connecting customers.
2. Deploy stable public HTTPS with reachable OAuth and webhook routes. Register `https://<your-host>/integrations/instagram/callback` as the exact redirect URI. Set webhook URL to `https://<your-host>/integrations/instagram/webhook`, enter the service's verification token and enable **comments** and **messages**.
3. Share database, native configuration and encryption key across API, workers and relay. Persist Temporal storage. `ROLE=all` runs all three. A separate API can publish with `DISPATCH_ENABLED=1` when workers and relay are configured.

Request `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`. Add public privacy and deletion information in the dashboard. Check Meta's [Instagram Login guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/) and [webhook guide](https://developers.facebook.com/docs/instagram-platform/webhooks/) for current requirements.

## Server settings

See [`.env.example`](../.env.example) and [configuration validation](../src/instagram/config.ts).

- `CONSOLE_ORIGIN` is your public HTTPS origin. `INSTAGRAM_REDIRECT_URI` adds the callback path above.
- `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` are Instagram Login credentials. `META_APP_SECRET` verifies webhook signatures.
- `INSTAGRAM_GRAPH_VERSION` includes the leading `v`. Choose a random `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` of at least 16 characters.
- `INSTAGRAM_TOKEN_ENCRYPTION_KEY` encodes 32 random bytes as base64. Keep it separately from database backups.
- `INSTAGRAM_CAPABILITIES_JSON` explicitly sets `privateReplyWindowHours`, `messagingWindowHours`, `sendsPerWindow`, `budgetWindowSeconds`, `recipientHourlyLimit` and `reconciliation`. Native reconciliation is `none`. Check current Meta limits and recipient policy before choosing windows and conservative budgets.

Set `DATABASE_URL`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE` for workers. Leave gateway `INSTAGRAM_BASE_URL` and `INSTAGRAM_API_TOKEN` empty in native mode. Partial native configuration fails startup.

## Connect and verify

In **Accounts**, choose **Connect Instagram**. The server checks single-use state and operator session, exchanges the code, checks grants, reads identity and subscribes the account to both webhook fields.

Publish a rule. From an eligible second account, comment its keyword on a supported post. Check Instagram for the public reply and private question. Reply with an email, then check the follow-up link and console timeline. After a send timeout, inspect the conversation before authorizing another attempt.

Our live check reached webhook verification. Test login and DMs with eligible accounts.

## Verify the webhook address before account login

Build, then run the standalone loopback webhook listener with a private environment file.

```sh
node --env-file=.local/instagram-webhook/listener.env dist/instagram/webhook-server.js
```

Set `PORT` and `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, then route the public webhook path there. With only the token, it answers Meta's GET challenge and returns 503 for deliveries. Account login requires the full application.

For signed ingestion, add the real `META_APP_SECRET` and migrated workspace `DATABASE_URL`, restart, connect the account and subscribe to both fields. Register the full application's callback URL for OAuth.

## Optional destinations

CRM and alert deliveries wait in PostgreSQL until their credentials and relay are configured. Leads and incidents remain available locally.

## Deploy a public callback host

Point DNS at a dedicated server, allow TCP 80/443 and provision workspace/operator access. Set `PUBLIC_HOST` to its DNS name and `BLOTATO_ENV_FILE` to the absolute private environment path. Containers need PostgreSQL and Temporal access.

```sh
docker compose -f compose.deploy.yaml up -d --build
```

Caddy manages TLS. The proxy alone publishes ports. Reuse existing TLS ingress. Arrange hosting and DNS separately.

## Disconnect or recover an account

Disconnect removes the stored token and blocks new sends. In-flight calls can finish. Revoke the Meta grant separately in Instagram. Reconnect with fresh consent after credentials expire or are rejected.

Credential generations prevent delayed failures from invalidating newer connections. Meta deauthorization and automatic data-deletion callbacks are unimplemented. Assign someone to handle customer deletion requests.
