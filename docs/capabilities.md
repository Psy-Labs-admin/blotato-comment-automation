# What can I do with a workspace?

## Build a rule

Start with a keyword, a public reply, a private question and a link. Save a partial draft, come back later, then publish it against a ready Instagram account. If two editors save at once, the second gets a revision conflict and can fetch the latest draft. Publishing a new version changes what the next person gets. Anyone already mid-conversation finishes on the old version. [Connect an account](instagram.md) · [Edit from your own admin](integration.md)

## Follow a conversation

A comment like “Pricing?” matches the whole word `pricing`. If two rules match, priority picks the winner. While one run owns the conversation, a second comment can't start a competing one. A fast reply still counts if it arrives while Instagram is acknowledging the private question. The run can ask for clarification or time out if the person never sends a usable address. [Matching and reply handling](design.md)

Open the run timeline to see which rule won, whether the reply contained a usable email and which sends Instagram accepted. Acceptance is as far as we can see. A correctly formatted address creates a lead and queues a CRM update. A CRM outage doesn't hold up the link DM. Email ownership and marketing consent need their own checks. [Leads API](integration.md)

## Stop or recover a run

| What you need | What happens |
|---|---|
| Disable a rule | Stops new runs. Existing ones can finish. |
| Pause an account | Holds eligible sends until you resume or their window expires. |
| Take over a conversation | Cancels its active run and blocks new ones until you release it. A participant's STOP also blocks future automated sends. |
| Resolve an uncertain DM | Check Instagram, then record acceptance or authorize one retry. An in-flight call can still succeed. |

Operations also shows stuck CRM jobs, missing post details and worker health. You can route grouped incidents to Telegram and see whether Telegram accepted the alert. [Recovery steps](operations.md) · [Telegram setup](telegram.md)
