# Blotato handbook

| Start here | What you will find |
|---|---|
| [Run the project](../README.md#run-it) | Install the workspace, sign in and save your first draft. |
| [Integrate your admin or CRM](integration.md) | Issue a key, call the API, edit a draft and follow a conversation. |
| [Swagger reference](https://psy-labs-admin.github.io/blotato-comment-automation/) · [Download OpenAPI](../src/api/openapi.json) | Methods, payloads, responses and operation IDs for client generation. |
| [Product capabilities](capabilities.md) | Rules, account controls, conversations, leads, operational recovery and the conditions each feature requires. |
| [Architecture](design.md) | Execution model, persistence, concurrency, failure modes, scaling and the limits of delivery guarantees. |
| [Instagram and deployment](instagram.md) | Native login and gateway modes, public HTTPS, webhook verification and live acceptance. |
| [Operations](operations.md) · [Monitoring](monitoring.md) | Readiness, recovery, retention, external alerts and deployment configuration. |
| [Telegram](telegram.md) · [Tracing and load tests](observability.md) | Notification setup, receipt semantics, traces and traffic measurements. |
| [Worker upgrades](worker-upgrades.md) · [Verification](testing.md) | History replay, process replacement, browser checks, API contracts and CI evidence. |

## Design decisions

1. [Why Temporal owns orchestration and PostgreSQL owns application facts](decisions/001-durable-orchestration.md)
2. [How the send ledger handles a lost acknowledgement](decisions/002-external-send-guarantees.md)
3. [Why one conversation has one active owner](decisions/003-conversation-ownership.md)

The [contribution statement](../AI_USAGE.md) describes the use of AI in the implementation and verification.
