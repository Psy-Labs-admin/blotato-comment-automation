# Connect Instagram

Blotato supports Instagram API with Instagram Login for professional accounts. The account owner authorizes comment and message access through Instagram. Credentials stay on the server. See [Meta’s Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-3fe78620-2258-44b6-893f-42d76c7200d7).

## Before enabling a workspace

1. In the Meta App Dashboard, set up the Instagram product with Instagram Login. For testing, use an eligible professional account with the required app role. For other customers, obtain the access level and approvals applicable to your app.
2. Deploy the API on a stable public HTTPS origin and route the callback and webhook paths to it. A loopback-only installation supports local editing. Meta needs a reachable endpoint for deliveries.
3. Register the exact redirect URI ending in `/integrations/instagram/callback`. Configure the Instagram webhook at `/integrations/instagram/webhook` with the same verification token as the service. Enable the **comments** and **messages** fields in the dashboard.
4. Configure the API, worker and relay with the same PostgreSQL database, native Instagram settings and encryption key. Run Temporal with persistent storage. `ROLE=all` runs the three application roles together. Separate deployments can opt the API into publishing with `DISPATCH_ENABLED=1` when workers and relay are configured.

The OAuth permissions are `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`. Configure the app’s required public privacy and data-deletion information for the organization operating the service. [Meta App Dashboard](https://developers.facebook.com/apps/) · [Instagram Login guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/) · [Instagram webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks/)

## Server settings

| Variable | Value |
|---|---|
| `CONSOLE_ORIGIN` | Public HTTPS origin for the console, also used for authenticated browser sessions |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Instagram Login credentials for the product in the Meta dashboard |
| `META_APP_SECRET` | Secret of the subscribing Meta app, used to verify webhook signatures |
| `INSTAGRAM_REDIRECT_URI` | Full registered callback URI on the console origin |
| `INSTAGRAM_GRAPH_VERSION` | Graph version selected and supported by the app, including the leading v |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | A high-entropy shared verification value entered in the webhook subscription |
| `INSTAGRAM_TOKEN_ENCRYPTION_KEY` | Base64 encoding of 32 random bytes. Keep this key in a secret store separate from database backups |
| `INSTAGRAM_CAPABILITIES_JSON` | Confirmed private-reply and follow-up windows and conservative account and recipient budgets |
| `DATABASE_URL`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` | Database, orchestration service and the queue where this installation's workers listen |

The capability fields are `privateReplyWindowHours`, `messagingWindowHours`, `sendsPerWindow`, `budgetWindowSeconds`, `recipientHourlyLimit` and `reconciliation`. Use `none` for native reconciliation. Choose the numerical values after checking the supported use case, current Meta limits and your own recipient policy. The service rejects incomplete configuration. The optional normalized integration gateway is an alternative for deployments that already operate one.

## Connect and verify

In **Accounts**, choose **Connect Instagram**. The callback verifies the single-use authorization state and the initiating operator session, exchanges the authorization code on the server, checks the grants, reads the account identity and subscribes the account to the two webhook fields. After these steps, the account appears by its Instagram name.

Publish a rule for that account and comment its keyword from an eligible second account on a supported post. Verify the public response and private question in Instagram, reply with an email address, then verify the follow-up link. The conversation view records the outcome at each step. If the external result is uncertain, the operator needs evidence before authorizing a resend.

The repo's contract tests cover signing, OAuth exchange and refresh, account-scoped sending, duplicate callbacks and error handling. The operator must perform the live acceptance check with a real Meta application, account and deployed HTTPS origin.

## Optional destinations

CRM and external alerts use independently configured delivery services. Without an external CRM or notifier, leads and incidents remain in PostgreSQL and their outbox rows stay pending. Adding the relevant credentials and starting the corresponding relay permits delivery to those destinations.

## Deploy a public callback host

On a dedicated server, point the service's DNS record at the server and permit inbound TCP 80/443. Supply `PUBLIC_HOST` as the DNS name and `BLOTATO_ENV_FILE` as the absolute path to your private service environment. The container must be able to reach PostgreSQL and Temporal at the addresses in that file. Provision the workspace and operator credentials before opening access.

```sh
docker compose -f compose.deploy.yaml up -d --build
```

Caddy obtains and renews TLS certificates for that host. Only the proxy publishes ports. For a host that already terminates TLS for other applications, deploy the application image behind its existing ingress instead of starting a second listener on those ports. No domain or hosting account is created by this command.

## Disconnect or recover an account

An operator can disconnect a native account in **Accounts**. The service removes its stored access token and stops new sends for that connection. Calls already in flight can still finish. This local action does not claim to revoke the grant at Meta. The owner can remove the app in Instagram to revoke that grant. Fresh consent is required to reconnect the account here.

A rejected or expired credential puts the affected connection into reconnect-required state. Refresh attempts and authorization failures are bound to a credential generation so a delayed response cannot invalidate a newer connection. The service does not expose a Meta deauthorization or automatic data-deletion callback. Configure the organization’s deletion instructions and request handling in the app dashboard as applicable.
