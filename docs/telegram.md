# Telegram incident notifications

Set deployment secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for one trusted chat. Grant send permission. Keep both out of UI, URLs, Git and tickets.

Check receipts in **Operations**. Startup is quiet. Pending alerts survive late configuration.

## Check the channel

Build first, then run this in the deployment environment.

```sh
node --env-file-if-exists=.env dist/alerts/check.js
```

This calls `getMe` and `getChat`, checking chat access. Test posting permission with one message.

```sh
node --env-file-if-exists=.env dist/alerts/check.js --send-test
```

The test sends once without retries. Keep it out of scheduled checks. Inspect the chat before repeating uncertain sends. Output hides credentials, chat IDs, URLs and provider descriptions.

## Delivery behavior

Postgres stores results. Acceptance requires `ok: true` and a valid Telegram receipt. Redirects, malformed responses, timeouts and network failures mean uncertainty. Errors use fixed codes.

After a 429, relays for that destination wait for `parameters.retry_after`, or 60 seconds when it is missing. A Postgres lock serializes sends. Waiting uses no attempts. Failures stop at the relay limit, normally 25. Token, chat or request rejection stops immediately. Inspect dead jobs in **Operations**. The retry API cannot replay them.

Use numeric chat IDs. Destination identity combines numeric bot ID and canonical chat ID. Same-bot token rotation preserves history and rate limits. Changing bot, chat or username-to-numeric spelling creates a new destination. Webhook authentication-token rotation also preserves context.

If an incident clears before the opening alert gets through, the relay skips the stale alert. If Telegram accepted the opening, the chat gets the recovery too. Each chat has its own history.

The relay saves the receipt before finishing the outbox job. A worker that finds the receipt can safely move on. Telegram has no `sendMessage` idempotency key. Timeouts or crashes before receipt storage can duplicate on retry. `unknown` records uncertainty. `accepted` confirms Telegram acceptance. Neither confirms that the operator read it.

Messages carry fixed playbooks, internal workspace/connection references, run counts and timestamps. They exclude customer names, usernames, emails, participant IDs, message bodies and raw errors. `CONSOLE_ORIGIN` supplies authenticated `#incident=<id>` links, falling back to `#operations`. Use HTTPS or local development HTTP without embedded credentials or query strings.

## Outcomes and troubleshooting

| Outcome or code | What to do |
|---|---|
| `accepted` | Check the accepted time and the chat. |
| `skipped` / `alert_obsolete` | Read the incident journal if you need the history. |
| `telegram_rate_limited` | Wait for the shared automatic deadline. |
| `telegram_token_rejected` | Replace the token, then run the read-only check. |
| `telegram_chat_forbidden` | Check bot membership and send permission. |
| `telegram_request_rejected` | Check the deployment’s chat settings. |
| `telegram_connection_unknown`, `telegram_service_unavailable`, `telegram_response_invalid`, `telegram_confirmation_invalid` | Inspect the chat and receipts. A retry may duplicate the message. |
| `alert_delivery_unconfigured` | Configure the deployment channel. |
| `alert_scope_invalid` | Investigate tenant, incident and outbox integrity. No message was sent. |

Receipts show attempts, outcome, safe reason, acceptance and retry deadline. Diagnostics hide destination hashes, provider IDs and configuration. The journal tracks opening, latest occurrence and resolution. Recovery means the condition cleared.

Configure [external monitoring](monitoring.md#enable-telegram-for-one-selected-operator) on another host for API and role alerts. The app’s relay needs a working app.
