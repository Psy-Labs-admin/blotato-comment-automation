# ADR 002 — Give uncertain sends their own state

Accepted.

Instagram may accept a message just before our worker loses the response. Retrying could duplicate it. Recording success before the call could hide a lost message. Neither gives us a trustworthy timeline.

Each logical send has one ledger entry and separate attempts. The worker reserves an attempt under the conversation lock, commits, then calls Instagram once. The result belongs to that attempt. After a crash, the next worker checks the ledger. An accepted send is done. A call interrupted halfway through lands in `unknown`. We retry automatically only when we know the message didn’t go out.

An unknown send ties up the conversation and opens an incident. A late acceptance, supported provider lookup or audited operator decision can settle it. Native Instagram has no configured lookup. An operator can authorize one new attempt, with a real duplicate risk if the original arrived.

This costs human attention when evidence runs out. It also keeps uncertainty visible. Temporal retries alone cannot tell us what Instagram received.
