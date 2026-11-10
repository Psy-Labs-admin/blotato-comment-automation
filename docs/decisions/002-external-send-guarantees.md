# ADR 002 — Give uncertain sends their own state

Accepted.

Instagram accepts a DM, then the response disappears. Retrying may duplicate it. Recording success before calling may hide a lost message.

Each logical send has a ledger entry and separate attempts. Under the conversation lock, the worker reserves and commits an attempt, calls once, then records its result. Recovery leaves accepted sends complete and interrupted calls `unknown`. Automatic retries require evidence the send never took effect.

Unknown sends hold ownership and open an incident. Late acceptance, supported lookup or an [audited operator decision](../operations.md#send_outcome_unknown) can settle them. Native Instagram has no configured lookup. For an active run, an operator can authorize one new attempt. Bad evidence can still mean a second DM.

This costs human attention and stalls progress when evidence runs out. Temporal retries cannot establish what Instagram received.
