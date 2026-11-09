# Connect Instagram

Choose **Instagram Login** for a professional account. If the dashboard gives you a **Unified Login** configuration ID, you’re in the Facebook Login for Business flow. This connector needs the Instagram Login app ID and secret.

## Before enabling a workspace

1. Configure Instagram Login in the [Meta App Dashboard](https://developers.facebook.com/apps/). Test with an eligible professional account and required app role. Obtain applicable access and approvals before connecting customers.
2. Deploy a stable public HTTPS origin with reachable OAuth and webhook routes. Register the exact redirect URI `https://<your-host>/integrations/instagram/callback`. Set the webhook URL to `https://<your-host>/integrations/instagram/webhook`, enter the service's verification token and enable **comments** and **messages**.
3. Give API, workers and relay the same database, native configuration and encryption key. Use persistent Temporal storage. `ROLE=all` runs all three roles. A separate API can publish with `DISPATCH_ENABLED=1` when workers and relay are configured.

Permissions are `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`. Configure public privacy and deletion information in the dashboard. Check Meta's [Instagram Login guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/) and [webhook guide](https://developers.facebook.com/docs/instagram-platform/webhooks/) for current requirements.

## Server settings

See [`.env.example`](../.env.example) and [configuration validation](../src/instagram/config.ts).

- `CONSOLE_ORIGIN` is the public HTTPS origin. `INSTAGRAM_REDIRECT_URI` must use that origin and the callback path above.
- `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` are Instagram Login product credentials. `META_APP_SECRET` verifies webhook signatures.
- `INSTAGRAM_GRAPH_VERSION` includes the leading `v`. `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` is a random shared value of at least 16 characters.
- `INSTAGRAM_TOKEN_ENCRYPTION_KEY` is the base64 encoding of 32 random bytes. Store it separately from database backups.
- `INSTAGRAM_CAPABILITIES_JSON` explicitly sets `privateReplyWindowHours`, `messagingWindowHours`, `sendsPerWindow`, `budgetWindowSeconds`, `recipientHourlyLimit` and `reconciliation`. Native reconciliation is `none`. Choose windows and conservative budgets after checking current Meta limits and recipient policy.

Configure `DATABASE_URL` and the `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE` used by these workers. In native mode, leave gateway `INSTAGRAM_BASE_URL` and `INSTAGRAM_API_TOKEN` empty. Partial native configuration fails startup.

## Connect and verify

In **Accounts**, choose **Connect Instagram**. The server checks single-use state and operator session, exchanges the code, checks grants, reads the account identity and subscribes it to both webhook fields.

Publish a rule for that account. From an eligible second account, comment the keyword on a supported post. Check the public reply and private question in Instagram, reply with an email, then check the follow-up link and console timeline. If a send times out, check the Instagram conversation before you authorize another attempt.

Our live check stopped after Meta verified the webhook address. Use the steps above to test a real DM on your own account.

## Verify the webhook address before account login

The standalone loopback listener exposes only the webhook path. From a built checkout, run with a private environment file.

```sh
node --env-file=.local/instagram-webhook/listener.env dist/instagram/webhook-server.js
```

Set `PORT` and `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, then route the public webhook path to that port. With only the token configured, it answers Meta's GET challenge and returns 503 for deliveries. That verifies the address. Account login needs the full application.

For signed ingestion, add the real `META_APP_SECRET` and migrated workspace `DATABASE_URL`, restart, connect the sending account and subscribe to both fields. OAuth needs the full application's callback URL registered above.

## Optional destinations

CRM and alert deliveries remain pending in PostgreSQL until their credentials and relay are configured. Leads and incidents remain available locally.

## Deploy a public callback host

Point DNS at a dedicated server and allow inbound TCP 80/443. Set `PUBLIC_HOST` to its DNS name and `BLOTATO_ENV_FILE` to the absolute private environment path. Provision workspace/operator access first. The container needs reachable PostgreSQL and Temporal.

```sh
docker compose -f compose.deploy.yaml up -d --build
```

Caddy manages TLS. Only the proxy publishes ports. Use existing ingress if the host already terminates TLS. This command creates no domain or hosting account.

## Disconnect or recover an account

Disconnect removes the stored token and blocks new sends. In-flight calls can finish. Revoke the Meta grant separately in Instagram. Reconnect with fresh consent.

Rejected or expired credentials require reconnection. Credential generations prevent delayed failures from invalidating a newer connection. Meta deauthorization and automatic data-deletion callbacks are not implemented. Give customers a way to request deletion and assign someone to handle those requests.
