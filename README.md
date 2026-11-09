# Instagram comment automations

Someone comments “pricing” on a post. The account replies in public, asks for an email in private, then sends the link in an Instagram DM. The interesting bit is what happens if the worker crashes between “send” and “sent”.

## Run it

Start Docker with Compose and use Node.js 24+ on macOS or Linux.

```sh
git clone https://github.com/Psy-Labs-admin/blotato-comment-automation.git
cd blotato-comment-automation
npm run quickstart
```

Quickstart starts Postgres and opens the console. Go to **Automations**, save a draft and reload. Your draft is still there. Connect an account when you’re ready to run the rule on real comments. On a headless machine, add `-- --no-open` to print the workspace URL and skip the browser. On a desktop, `node scripts/admin.cjs open` signs you back in.

## Connect your own admin

From a second terminal in the checkout, give your backend a read key and try the sample client.

```sh
export BLOTATO_API_KEY="$(npm run --silent api:key -- create reviewer)"
node examples/external-admin.mjs
```

You'll see your workspace, account count, recent runs and lead count. The example uses port 3000. If quickstart printed another port, set `BLOTATO_API_URL` to that origin plus `/api/v1`. Keep the key on your server. Open `/docs/` on your running workspace to try a request. The walkthrough also shows how to issue a write key for edits. [API walkthrough](docs/integration.md) · [Public Swagger reference](https://psy-labs-admin.github.io/blotato-comment-automation/)

## Why Postgres and Temporal?

Postgres remembers which comment started the run and which sends we attempted. Temporal remembers where to pick up if the person replies tomorrow. Each run sticks to the rule version it started with, even if someone edits the rule over lunch.

Say Instagram accepts the DM, then the connection drops before we get a response. A timeout is a lousy reason to DM someone twice. We hold the conversation so an operator can check Instagram before deciding whether to retry. [How it works](docs/design.md)

## How far can you test it?

Run `npm run verify` for the full conversation, duplicate webhooks and worker crashes against disposable Postgres and Temporal. The tests control Instagram's responses. The live Meta check covered webhook verification only. A real comment-to-DM run still needs a connected account and a running worker. [Test guide](docs/testing.md) · [Instagram setup](docs/instagram.md)

[Handbook](docs/README.md) · [CI results](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/checks.yml) · [How we used AI](AI_USAGE.md)
