# Demo (5–7 minutes)

## Run it

```bash
docker compose up -d          # Postgres :55432, Temporal :7233, Temporal UI :8233
npm install
npm run dev                   # API :3000 + worker + relay + fake Instagram/CRM/alert sink
npm run demo                  # in a second terminal
```

No Docker for Temporal? `npm run dev:embedded` starts the official Temporal dev server in-process.
It still needs Postgres via `DATABASE_URL`.

## What to show

1. **Happy path** (1 min). Comment → public reply → private reply asking for the email → reply with
   an email → DM with the link. Then read the printed timeline: every line is a recorded fact, and
   the lead is stored as `format_valid_unverified`.
2. **Duplicate webhooks** (30 s). The same comment is posted three times: one `accepted`, two
   `duplicate`, one run, no extra messages.
3. **Lost acknowledgement** (2 min). The fake Instagram stores the link DM and then drops the
   connection. The run goes to `blocked_unknown`, the conversation stays held, and one grouped
   incident reaches the alert sink with no personal data. The operator confirms in the inbox and
   resolves via the API. The run completes and Instagram holds exactly one DM.
4. **CRM outage** (1 min). The CRM is down: the person still gets the link and the lead stays
   `pending`. When the CRM is back, the lead is `synced`, and the alert sink shows the incident opening and resolving.
5. **Funnel and metrics** (30 s). `GET /funnel` (run cohort) and `GET /metrics`.
6. **Restart during a wait** (optional, 1 min, manual): comment, stop `npm run dev` while the run is
   `waiting_input`, send the email webhook after restarting. The run continues and the deadline in
   `GET /runs/:id` is unchanged. The automated version of this is
   `tests/failure-scenarios/restart.test.ts`.

Open http://localhost:8233 to show the workflow histories in the Temporal UI.

## Excerpt of real output

```
3. Instagram accepts the link DM but the acknowledgement is lost
   ✔ run is blocked_unknown; intent 04297d02 status=unknown; conversation held; nothing re-sent
   alert sink received:
     [INCIDENT] Instagram sends with unknown outcome
     Demo Coffee Co · account ig_demo_coffee
     Affected conversations: 1 · occurrences: 1 · since 2026-11-07T09:56:41.573Z
     Done automatically: Conversations are held, nothing is re-sent automatically; …
     Action: Review GET /runs?status=blocked_unknown and resolve each intent via POST /intents/:id/resolve.
   operator checks the Instagram inbox and confirms the DM is there:
   ✔ run completed; DMs Instagram stored for carol_1348: 1 (no duplicate)
   …
   09:56:41.569  DM (send_link): attempt 1 sent to Instagram
   09:56:41.574  DM (send_link): outcome UNKNOWN (provider_no_confirmation: connection_lost) — conversation held, no automatic resend
   09:56:41.588  Run paused until the uncertain send is resolved
   09:56:41.917  DM (send_link): outcome resolved as accepted (operator)
   09:56:42.006  Run finished: completed
   09:56:42.010  Conversation released
```

## Poking it by hand

```bash
T=$(jq -r .tenantId .demo.json)   # written by `npm run seed` / the demo
curl -s -XPOST localhost:3000/webhooks/instagram -H 'content-type: application/json' -d '{
  "type":"comment.created","accountId":"ig_demo_coffee","commentId":"c1","mediaId":"m1",
  "from":{"id":"u1"},"text":"pricing?","occurredAt":"2026-11-07T10:00:00Z"}'
curl -s localhost:3000/runs -H "x-tenant-id: $T" | jq
curl -s -XPOST localhost:4001/__control/faults -d '{"mode":"accept_then_drop","kind":"dm"}'   # inject a fault
```

Fault modes: `ok`, `reject_permanent`, `unauthorized`, `rate_limit`, `unavailable`,
`accept_then_drop`, `accept_then_500`, `delay` (optionally scoped by `kind` / `textIncludes`).
