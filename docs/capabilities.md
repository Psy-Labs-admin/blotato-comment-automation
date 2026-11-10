# What can I do with a workspace?

Turn keyword comments into conversations, capture emails and send links.

## Build a rule

Choose a keyword, public reply, private question and link. Save partial drafts, then publish against a ready Instagram account. If two editors save together, the second gets a revision conflict and must fetch the latest draft.

New runs use the published version. Active conversations retain their starting version. [Connect an account](instagram.md) · [Edit from your own admin](integration.md)

## Follow a conversation

“Pricing?” matches the whole word `pricing`. Priority chooses between matching rules. While one run owns the conversation, another comment cannot start a competing run. Replies count even while Instagram acknowledges the question. The run can ask for clarification or time out without a usable email. [Matching and reply handling](design.md)

The timeline shows which rule won, email validation and sends Instagram accepted. Acceptance cannot prove someone read the message. A correctly formatted email creates a lead and queues a CRM update. A CRM outage does not delay the link DM. Check email ownership and marketing consent separately. [Leads API](integration.md)

## Stop or recover a run

| What you need | What happens |
|---|---|
| Disable a rule | Stops new runs. Existing runs can finish. |
| Pause an account | Holds eligible sends until resumed or their window expires. |
| Take over a conversation | Cancels its run and blocks new runs until released. A participant's STOP also blocks future automated sends. |
| Resolve an uncertain DM | Check Instagram, then record the outcome. Confirming a non-send allows an active run one retry. A finished run stays closed. |

Operations shows CRM failures, missing post details and worker health. Route grouped incidents to Telegram and check alert acceptance. [Recovery steps](operations.md) · [Telegram setup](telegram.md)
