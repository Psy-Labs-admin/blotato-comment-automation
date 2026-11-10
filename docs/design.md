# How a comment becomes a conversation

Someone comments “pricing”, gets a DM asking for their email, and replies straight away. Meanwhile, our worker is still on `await send()`. The person is already a whole message ahead of us.

In the test, we hold the acknowledgement for 1.5 seconds and slip the email into that gap. The worker still sends exactly one link. Here’s what has to agree for that to work. [Fast-reply test](../tests/failure-scenarios/races.test.ts)

<a id="1-the-promise"></a>
<a id="2-product-contract"></a>

## The flow we support

“Sent you a DM!” is a bold thing to say one HTTP call before you actually send it. The brief asks for the public reply first, so the rule keeps that order. “I’ll send the details privately” gives the private call some room to fail.

A rule can watch all supported posts or a list of media IDs. Edited comments, our own comments and webhook echoes can’t start it. We normalize the text and look for whole words. By default `#PRICING!` matches `pricing` and `prcing` goes through quietly.

### When someone types “prcing”

Turn on **Allow simple typos** in the rule editor and publish. The router accepts one slip in a word of six or more Latin or Cyrillic letters. For a phrase, the words still have to appear together in order. Only one word in the entire phrase gets a second chance.

| Comment for the keyword `pricing` | Decision with typos enabled |
|---|---|
| `#PRICING!` | Exact match. Case and punctuation already work. |
| `prcing please` | Match. One interior letter is missing. |
| `pricign` or `rpicing` | Match. Two neighboring letters traded places. |
| `priicing` or `pricingg` | Match. Someone hit the same key twice. |
| `prizing`, `price`, `pricingplan` | Skip. We don’t substitute letters, guess synonyms or match inside longer words. |
| `прайсинг` | Skip for the English keyword. To trigger on the Cyrillic spelling, give it its own rule. |

This checks spelling. It can’t tell what a person meant. For instance, `singed` can trigger an opted-in `signed` rule. Keep exact matching for keywords where a neighboring real word would send the wrong DM.

An exact match always wins. If several rules match exactly, priority wins, then automation ID breaks the tie. With only typo matches, exactly one eligible rule must remain. For example, `psting` could mean `posting` or `pasting`. If both rules watch that post, we record `ambiguous_keyword` and send nothing. The winning run’s timeline tells the operator when a typo triggered it. This setting applies to comment keywords only. Email replies and STOP commands use their own checks. [Matcher tests](../tests/unit/matching.test.ts) · [Routing tests](../tests/integration/routing.test.ts)

If the same person comments twice, one run owns their conversation with that account. A competing trigger gets `conversation_busy` until the run finishes and its sends settle. Cooldown then applies if Instagram accepted a send. [Conversation ownership](decisions/003-conversation-ownership.md)

<a id="3-how-general-is-the-engine-and-why"></a>

## A small engine on purpose

A rule has up to ten steps. The pricing rule starts with `reply_comment`, asks through `send_private_reply`, pauses at `await_input` and finishes with `send_message`. The private question sits right before the wait. A regular DM needs a preceding wait. Each rule gets at most one private reply and one email wait, with a timeout from one second to 30 days and up to three clarifications.

When someone asks “Why did I get that link?”, we can pull up the step and the published version that supplied it. That gets harder once rules can loop or execute arbitrary code. Adding a step here means defining its inputs, teaching the workflow when to call it and writing the activity that does the work. [Definition and validation](../src/domain/definition.ts)

<a id="4-architecture"></a>

## Why Postgres and Temporal

Suppose we deploy while someone is typing their email. Postgres remembers the conversation, the original rule version and which sends we attempted. Temporal remembers where the run paused and when its timer expires. The replacement worker picks up the same wait. Doing the scheduling in Postgres too would give us a timer service of our own to debug. [Why we chose Temporal](decisions/001-durable-orchestration.md)

```mermaid
flowchart TB
    accTitle: Services behind one Instagram conversation
    accDescr: The API accepts signed events, serves the console and external clients, and exposes metrics to Prometheus. Postgres stores events and rules. The relay starts workflows in Temporal and delivers integration jobs. The worker records sends and calls Instagram.
    IG["Instagram"] -->|webhooks| API["Fastify API"]
    UI["Operator console"] -->|session| API
    Client["Your backend"] -->|workspace API key| API
    API -.->|metrics scrape| Monitor["Prometheus"]
    API -->|events, edits| PG[("Postgres")]
    PG -->|outbox| R["Relay"]
    R -->|start / signal| T["Temporal"]
    T -->|tasks| W["Worker"]
    W -->|send ledger| PG
    W -->|reply / DM| IG
    R -->|deliver| Dest["CRM / alerts"]
    classDef role fill:#155e58,stroke:#278477,color:#fff
    class API,R,W role
```

## Connect your own backend

Take the pricing rule out of our console and put it in your own admin. Your server calls `/api/v1` with a key scoped to one workspace. Give a reporting job a read key to fetch runs, their timelines and captured leads. Give the rule editor a write key to save drafts and publish them. The credential stays on your server.

When the editor creates a draft, it can send an `Idempotency-Key`. If the response disappears, the same key and body return the original draft. Edits and publication use `expectedRevision`, so two people editing the rule won’t silently overwrite each other. On publication the API checks the rule and account, then makes the new version available to future conversations. You can try this at `/docs/` on your installation or import `/openapi.json` into a client generator. [API walkthrough](integration.md) · [Public Swagger](https://psy-labs-admin.github.io/blotato-comment-automation/)

<a id="6-execution-model"></a>

## Getting work into the workflow

The API saves an incoming event and assigns its sequence number before acknowledging it. Native callbacks verify Meta’s signature and leave routing to the relay. The signed gateway tries routing inline. A background sweep picks up anything still pending.

When a rule wins, one transaction claims the conversation, creates the run and queues its start command in the `outbox`. If the process dies just after commit, the relay still has the command. Relays lease jobs using `SKIP LOCKED`. On retry they use the same Temporal workflow ID. Signals wake the workflow to check Postgres. A timer covers a missed signal.

<a id="8-waiting-for-input-boundary-deadline-and-races"></a>
<a id="9-concurrency-summary"></a>

## Fast replies and other races

Before the private question leaves, the worker records the current inbox sequence number and fixes the deadline. That gives us a slice of inbox history to check once Instagram confirms the send.

```mermaid
---
config:
  sequence:
    width: 88
    actorMargin: 20
    mirrorActors: false
---
sequenceDiagram
    accTitle: A reply arrives before the send acknowledgement
    accDescr: While the worker is waiting for Instagram, the API can already store an incoming reply. The worker reads that reply once the question has been accepted.
    participant W as Worker
    participant P as Inbox
    participant I as Instagram
    W->>P: Set reply boundary
    W->>I: Send question
    I->>P: Email arrives via webhook
    I-->>W: Send acknowledged
    W->>P: Read reply, save lead
    W->>I: DM the link
```

Say the person sends “yep” and follows up with their email. If both are waiting when the worker wakes, it reads the whole batch before asking for clarification. The first message with exactly one distinct valid address wins. Even two valid replies produce one lead. When the timer fires, it checks what arrived by the original deadline. A slow relay can’t make an on-time reply late.

<a id="7-external-sends-the-ledger-protocol"></a>

## The send that might have happened

Instagram accepts the DM. Our worker dies before recording the response. Sending it again feels reasonable right up until you look at the recipient’s inbox.

```mermaid
flowchart TD
    accTitle: How the next worker handles a lost DM receipt
    accDescr: For an active run, a saved acceptance lets work continue. An unfinished attempt holds the conversation for evidence. An operator can authorize a retry only while the run is active.
    L["Active run resumes and checks its ledger"] --> K{"What was saved?"}
    K -->|Accepted| Next["Continue the run"]
    K -->|Still in flight| Hold["Mark unknown and hold the conversation"]
    Hold -->|Late acceptance or operator confirms| Next
    Hold -->|Operator confirms no send| Retry["Allow one new attempt"]
    classDef review fill:#ffedc2,stroke:#a77723,color:#322811
    classDef done fill:#155e58,stroke:#278477,color:#fff
    class Hold review
    class Next done
```

Every attempt gets its own record. The worker commits the reservation, calls Instagram once with the lock released, then records the result against that attempt. Proven transient non-sends can retry automatically. For an interrupted call, the native connector has no lookup that can tell us whether that particular DM landed. The operator checks Instagram and records the evidence. If the run has already ended, confirming a non-send cancels the intent. A finished run stays finished. [Crash tests](../tests/failure-scenarios/crash-and-unknown.test.ts) · [Send ledger decision](decisions/002-external-send-guarantees.md)

<a id="5-data-model"></a>

## The records that matter

Start at `automation_runs` when a reviewer asks where a link came from. Each run points to its conversation and the exact version it used. Follow the other direction to see what the run tried to send.

```mermaid
erDiagram
    accTitle: Which database records belong to one run
    accDescr: A run belongs to one conversation and one published version. It can capture at most one lead and can have several send intents. Each intent keeps its attempts.
    conversations ||--o{ automation_runs : contains
    automation_versions ||--o{ automation_runs : governs
    automation_runs ||--o| leads : captures
    automation_runs ||--o{ message_intents : requests
    message_intents ||--o{ message_attempts : records
```

For a reply, follow the lead’s `source_event_id` back to `inbox_events`. Provider IDs deduplicate within an account. `input_waits` keeps the question boundary and deadline, and `input_consumptions` records which reply counted. [Database schema](../migrations/001_init.sql)

<a id="10-instagram-constraints-and-anti-spam"></a>
<a id="11-failure-modes"></a>
<a id="12-observability"></a>
<a id="13-change-management"></a>

## Controls and recovery

A lot can change while a message is queued. Each send reservation checks cancellation, opt-out, takeover, account permissions, messaging windows and rate limits. A pause can defer a send for up to 24 hours. A participant’s STOP records opt-out and cancellation together. A call already in flight may still land.

If the CRM is having a bad afternoon, the link DM can still go out. Saving a lead queues a separate CRM job. The relay retries with the same idempotency key, which the receiver must honor. An exhausted job shows up in Operations with its history. [Recovery playbooks](operations.md#incident-playbooks)

## How we tell when it’s stuck

If one person is waiting, open their run timeline in the console or call `GET /api/v1/runs/{id}/timeline`. It shows which rule won, whether the reply counted and what Instagram actually acknowledged. If *everyone* is waiting, start with `/ready` and the age of the oldest queued event.

Prometheus scrapes the protected `/metrics` endpoint. Six alert rules cover an unreachable API, a missing worker or relay, delayed or stopped deliveries, a routing backlog and sends stuck in `unknown`. That catches a failure you won’t see from an HTTP 200 on `/health` alone. Alertmanager can send these service alerts to Telegram. Application incidents and their delivery receipts are also visible in **Operations**. [Monitoring diagram](monitoring.md) · [Alert rules and thresholds](operations.md#signals-to-watch)

## How a change reaches a server

Every push to `main` goes through GitHub Actions. CI tests the backend, browser flows and alert rules, then packages the API. A fresh runner loads that exact image, starts Postgres, races two draft writes and restarts the API. It also checks that an incomplete image transfer leaves the running service alone.

To deploy, select the successful run ID in **Deploy backend**. Rehearsal uses a disposable runner. Production uses the configured host and checks the running image, container health and public HTTPS readiness. Selecting an older compatible build uses the same path. Its database migrations still need to work with that build. [Release diagram and runbook](releases.md)

<a id="14-scale"></a>
<a id="15-limitations-and-next-steps"></a>

## What still needs care

A sequence number tells us which message came first. It can’t tell us whether an email was the answer to some *other* question in the same inbox. A format check can’t tell us who owns the address either.

A worker upgrade has to replay conversations that are still open. For a change in step order, we use patches or pinned builds and test old histories before rollout. For an actual comment-to-DM check, we need public HTTPS and an authorized professional Instagram account. [Worker upgrades](worker-upgrades.md) · [Load check](observability.md#reproducible-load-check) · [Instagram setup](instagram.md)
