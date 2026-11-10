# ADR 003 — One conversation gets one active run

Accepted.

Two pricing comments should not start questions competing for one reply. A reply can also arrive before the question's send is acknowledged.

A conversation is one connected account and participant. Workers lock its row first for replies, send reservations and completion. `owner_run_id` admits one active run. Competing triggers record `conversation_busy`. Matching rules choose by priority, then automation ID.

Ownership releases after completion and settled sends. Unknown sends hold it. Any accepted send starts cooldown at release. Each send reservation checks cancellation, opt-out and takeover.

Other participants proceed independently, but concurrent automations for one person are outside v1. Busy triggers are recorded without queueing. Without reliable reply references, we still infer which question a DM answers. See the [walkthrough](../design.md).
