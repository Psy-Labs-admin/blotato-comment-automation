# Telegram incident notifications

Set deployment secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for one trusted operator chat. Add the bot and grant send permission. Keep both values out of UI, URLs, tracked files and tickets.

Open **Operations** to see which alerts went out. Starting the service is quiet. If you configure the bot later, pending alerts are still in the queue.

## Check the channel

After building, run this from the deployment environment.

```sh
node --env-file-if-exists=.env dist/alerts/check.js
```

This calls `getMe` and `getChat`. A successful check means the bot can see the chat. To find out whether it can post there, send one test message.

```sh
node --env-file-if-exists=.env dist/alerts/check.js --send-test
```

Each invocation sends once without retries. Keep it out of scheduled health checks. After uncertain outcomes, inspect the chat before repeating. Commands hide credentials, chat IDs, URLs and provider descriptions.

## Delivery behavior

The relay keeps each alert in Postgres until it has a result. To mark it accepted, it needs `ok: true` and a valid Telegram message receipt. Malformed responses, redirects, timeouts and network failures leave acceptance uncertain. Only fixed error codes are stored.

If Telegram says “slow down” (429), every relay serving that chat waits for `parameters.retry_after`, or 60 seconds by default. A Postgres lock keeps two relays from sending at once. Waiting consumes no attempts. Failed attempts stop at the relay limit, 25 by default. Explicit token, chat or request rejection stops immediately. Review dead rows through Operations. The ordinary retry API cannot replay them.

Use a numeric chat ID. Destination identity combines the numeric bot ID and canonical chat ID. Rotate the token on the same bot and the relay still remembers rate limits and which incidents it already announced. Changing bot, chat or username-to-numeric spelling creates a new destination. Webhook destinations similarly retain context when only their authentication token rotates.

If an incident clears before Telegram accepts the opening alert, the relay skips the stale messages. If the chat saw the opening alert, it gets the recovery too. Switching chats starts a separate receipt history.

The receipt is saved before the outbox acknowledgement, so replay of a saved acceptance sends nothing. Telegram has no `sendMessage` idempotency key. Acceptance followed by a crash before receipt storage, or a timeout, can duplicate on retry. `unknown` records that uncertainty. `accepted` confirms provider acceptance. Only someone in the chat can tell you whether they read it.

Messages contain fixed playbooks, internal workspace/connection references, affected-run counts and timestamps. Customer names, usernames, emails, participant IDs, message bodies and raw errors are excluded. `CONSOLE_ORIGIN` supplies authenticated incident links through `#incident=<id>`, falling back to `#operations`. It accepts HTTPS or local development HTTP without embedded credentials or query strings.

## Outcomes and troubleshooting

| Outcome or code | Next step |
|---|---|
| `accepted` | Check accepted time and the chat. |
| `skipped` / `alert_obsolete` | Read the incident journal if history matters. |
| `telegram_rate_limited` | Let the shared automatic wait expire. |
| `telegram_token_rejected` | Replace the token and run the read-only check. |
| `telegram_chat_forbidden` | Check membership and send permission. |
| `telegram_request_rejected` | Check deployment chat configuration. |
| `telegram_connection_unknown`, `telegram_service_unavailable`, `telegram_response_invalid`, `telegram_confirmation_invalid` | Inspect chat and receipts. Retry may duplicate. |
| `alert_delivery_unconfigured` | Configure the deployment channel. |
| `alert_scope_invalid` | Investigate tenant/incident/outbox integrity. No send occurred. |

Receipts store attempts, outcome, safe reason, accepted time and retry deadline. Console diagnostics hide destination hashes, provider IDs and configuration. The journal records opening, latest occurrence and resolution. Recovery describes that condition clearing.

For independent API/role alerts through Alertmanager, follow [external monitoring](monitoring.md#enable-telegram-for-one-selected-operator).
