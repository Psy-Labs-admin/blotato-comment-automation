# ADR 001 — Temporal moves the run, Postgres keeps the facts

Accepted.

A person can take days to answer. The run needs to survive a restart, remember its deadline and resume the right step. Two workers still need to agree on who owns the conversation, which reply counted and who gets to send.

Each run gets a Temporal workflow. The worker checks Postgres before acting on a reply or a send. When we create a run, we write its start command in the same transaction. If the process dies before telling Temporal, the relay picks up the saved command.

A Postgres scheduler would save a service, then charge us in timer recovery, leases and inspection tools. A queue would spread the conversation state across consumers. Temporal already handles that work.

The cost is another service and deterministic workflow code. Changes need replay tests and patches or pinned worker deployments. The database still enforces the identities and constraints that keep retries safe.
