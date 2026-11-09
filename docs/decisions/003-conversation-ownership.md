# ADR 003 — One conversation gets one active run

Accepted.

Two “pricing” comments should not produce two questions competing for the same reply. An email arriving while the question is being sent needs a clear place to wait.

A conversation is one connected account and participant. Before touching a reply, a send or the end of a run, each worker locks that conversation’s row first. `owner_run_id` allows one active run. Competing triggers record `conversation_busy`. Matching rules use priority, then ID, to choose one winner.

Ownership releases after the run finishes and every send settles. Unknown sends keep it held. Cooldown applies if Instagram accepted at least one send in the run. Cancellation, opt-out and takeover are checked at each send reservation.

This serializes the awkward races without locking every participant together. It also means concurrent automations for one person are outside v1. Without a reliable reply reference, we still infer which question a DM answers.
