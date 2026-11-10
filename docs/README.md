# Blotato handbook

**Got five minutes?** [Start the console](../README.md#run-it) and save a draft. Then [read it from your own backend](integration.md) or try the same call in Swagger on your running workspace. [Public API reference](https://psy-labs-admin.github.io/blotato-comment-automation/)

**Reviewing the design?** Open the [system diagram](design.md#why-postgres-and-temporal). Follow [the email that beats the send acknowledgement](design.md#fast-replies-and-other-races), then see [what happens when the acknowledgement never comes](design.md#the-send-that-might-have-happened). The three short design decisions cover [durable waits](decisions/001-durable-orchestration.md), [safe retries](decisions/002-external-send-guarantees.md) and [who gets the next reply](decisions/003-conversation-ownership.md).

**Running the service?** Pick the job in front of you.

| I need to… | Open |
|---|---|
| Connect an Instagram account or change a live rule | [Instagram setup](instagram.md) · [Operator controls](capabilities.md) |
| Find out why a conversation stopped | [Recovery playbooks](operations.md) · [Traces](observability.md) |
| Get paged when a worker goes quiet | [External monitoring](monitoring.md) · [Telegram incident notifications](telegram.md) |
| Reproduce a failure or measure throughput | [Tests and reports](testing.md) · [Load check](observability.md#reproducible-load-check) |
| Ship a build while conversations are still open | [GitHub deployments](releases.md) · [Worker upgrades](worker-upgrades.md) |
