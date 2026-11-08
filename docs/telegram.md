# Telegram incident notifications

Notifications go to one deployment-managed operator chat. This is an operational channel, not a customer notification setting. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the deployment secret environment. Add the bot to the operator chat and grant permission to send messages. Do not enter bot tokens or chat identifiers in the application UI, URLs, source control or support tickets.

Starting the application does not probe Telegram. An absent configuration leaves notifications queued; it never marks them delivered. The operations console reports configuration and recorded delivery facts. A configured channel alone does not prove credentials, permissions or delivery.

## Check the channel

After building, run the read-only operator check from the deployment environment:

```sh
node --env-file-if-exists=.env dist/alerts/check.js
```

This explicitly calls `getMe` and `getChat`. It sends no messages. Successful output confirms bot authentication and chat visibility, with `deliveryTested: false`. Chat visibility does not establish sending permission.

To verify delivery, an operator may explicitly send one fixed test message:

```sh
node --env-file-if-exists=.env dist/alerts/check.js --send-test
```

This command checks the bot/chat, then sends one message per invocation. It has no retry loop and does not create an incident or claim production monitoring health. Do not run it as a health check or scheduled task. A failure after an unknown network outcome may still have delivered the message; inspect the chat before repeating. Neither command prints credentials, chat IDs, Telegram descriptions or request URLs. Normal development tests use loopback transports and never invoke these commands against Telegram.

## Delivery behavior

The durable outbox owns retries. Telegram HTTP status alone is insufficient: delivery requires an `ok: true` Bot API envelope and a valid Message receipt. `ok: false`, malformed successful responses, invalid receipts, redirects, network failures and timeouts are handled explicitly. Provider descriptions are discarded; only fixed error codes are persisted.

A 429 honors `parameters.retry_after`. A missing/invalid hint waits 60 seconds. The database records a destination flood wait shared by all relay processes. Telegram destination identity uses the numeric bot ID prefix and canonical chat ID, independent of the secret part of the bot token. Rotating the same bot token retains the flood wait and accepted-opening context; replacing the bot or changing the chat creates a different destination. Prefer a numeric chat ID: switching from an @username to its numeric ID is treated as a destination change because resolving aliases would require a network request. Webhook identity uses its normalized endpoint without its authentication token; rotating that token likewise retains destination context. Concurrent deliveries to that destination use a database session advisory lock; no SQL transaction is held during HTTP. The lock is released (or the pooled session discarded) on every exit. Other incident notifications wait without consuming retry attempts. Failures consume attempts and stop at the relay limit (25 by default); explicit token/chat/request rejections stop immediately. Dead alert rows require operator review and cannot be blindly replayed through the ordinary retry API.

For each incident, earlier pending notifications finish before later ones. If an incident has recovered before its first opening is accepted, obsolete opening/update/recovery notifications are recorded as `skipped`. If an opening was accepted, the recovery follows it. An update becomes an opening when no earlier notification was accepted. The incident journal remains the source of history even when notifications are skipped. After a permanent failure, later notifications can proceed; their meaning reflects whether an earlier delivery was accepted.

An accepted provider receipt is persisted before acknowledging the outbox row. Replaying an already accepted row does not send again, including after a destination change; its receipt remains associated with the original destination. Retries of an unconfirmed delivery record the currently attempted destination. Future updates become openings when the current destination has no accepted opening, and recovery is skipped if the current destination never accepted an incident notification. Changing destination does not replay historical deliveries. Telegram provides no sendMessage idempotency key: a crash after Telegram accepts but before the receipt is saved, or a timeout after acceptance, can produce a duplicate on retry. `unknown` records this uncertainty; there is no exactly-once guarantee. `accepted` means Telegram accepted the message, not that an operator read it. Recovery messages describe the recorded condition clearing, not independent end-to-end verification.

`alert_deliveries` records tenant, incident, outbox reference, channel, an opaque destination hash, attempt time/count, outcome, safe reason code, accepted time/message receipt and retry deadline. Tenant-scoped monitoring must filter by the authenticated tenant. Destination hashes, provider message IDs and raw configuration are internal diagnostics and are not exposed in the console. Shared flood waits are enforced internally without revealing another tenant's incident.

Messages contain fixed incident playbooks, internal workspace/connection references, affected automation run counts and timestamps. Playbooks direct operators to Accounts, Conversations and Operations in the admin console. Incident links use the actual `#incident=<id>` route, with `#operations` as a fallback. They exclude tenant display names, Instagram usernames, participant identifiers, email addresses, message bodies and raw upstream errors. A configured console link is accepted only for HTTPS (or local HTTP during development), without embedded credentials/query strings, and points to the console. Access still requires normal console authentication. Only trusted deployment operators should access the central chat; this design is unsuitable for a customer-accessible group.

## Outcomes and troubleshooting

| Outcome / code | Meaning and action |
| --- | --- |
| `accepted` | Provider accepted a valid response; see accepted time. |
| `skipped` / `alert_obsolete` | Incident recovered before an opening was accepted. Review the incident journal if needed. |
| `telegram_rate_limited` | Automatic destination-wide wait; do not manually retry. |
| `telegram_token_rejected` | Replace the deployment bot token, then run the read-only check. |
| `telegram_chat_forbidden` | Check bot membership and send permission in the operator chat. |
| `telegram_request_rejected` | Inspect deployment chat configuration; provider rejected the request. |
| `telegram_connection_unknown`, `telegram_service_unavailable`, `telegram_response_invalid`, `telegram_confirmation_invalid` | Acceptance is unconfirmed; bounded retry may duplicate. Inspect the chat and delivery history. |
| `alert_delivery_unconfigured` | Configure a deployment channel. Work remains pending without consuming attempts. |
| `alert_scope_invalid` | Invalid outbox/tenant/incident scope; no send was attempted. Investigate data integrity. |

The [official Bot API response contract](https://core.telegram.org/bots/api#making-requests), [response parameters](https://core.telegram.org/bots/api#responseparameters), [sendMessage](https://core.telegram.org/bots/api#sendmessage), and [getChat](https://core.telegram.org/bots/api#getchat) define the transport behavior used here.
