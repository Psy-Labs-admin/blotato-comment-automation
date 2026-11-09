# Blotato handbook

**Trying it out?** [Start a workspace](../README.md#run-it), save a draft, then [connect your own admin](integration.md). You can [browse every API call in Swagger](https://psy-labs-admin.github.io/blotato-comment-automation/).

**Reading the code?** Start with [the trip from comment to DM](design.md). Three short decisions explain [why we use Temporal](decisions/001-durable-orchestration.md), [when a send is safe to retry](decisions/002-external-send-guarantees.md) and [who gets the next reply](decisions/003-conversation-ownership.md). The [test guide](testing.md) points to the cases you can run.

**Running an installation?** Start with [releases and deployment from GitHub](releases.md).

- [Connect Instagram](instagram.md) and [see what operators can control](capabilities.md).
- [Set up monitoring](monitoring.md) and [send incidents to Telegram](telegram.md).
- [Recover a stuck run](operations.md), [inspect traces or measure load](observability.md), or [roll out a new worker](worker-upgrades.md).
