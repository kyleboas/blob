# Deployment Guide (Cloudflare Workers + Slack Events API)

## 1) Prerequisites

- Cloudflare account with Workers + Durable Objects enabled.
- Wrangler CLI authenticated (`npx wrangler login`).
- Slack app with bot token (`xoxb-...`).
- Anthropic API key.

## 2) Create Cloudflare resources

```bash
npx wrangler r2 bucket create blob-repo-store
```

## 3) Configure Worker secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
```

## 4) Configure sandbox service binding (optional for first deploy)

If you have a dedicated sandbox Worker, add a service binding in `wrangler.toml` before deploy:

```toml
[[services]]
binding = "SANDBOX"
service = "<your-sandbox-worker-name>"
```

If no sandbox service exists yet, you can still deploy without this binding. The agent will return a clear runtime error for tool calls until `SANDBOX` is configured.

## 5) Deploy

```bash
npx wrangler deploy
```

## 6) Configure Slack Event Subscriptions

1. Open your Slack app settings at <https://api.slack.com/apps>.
2. Go to **Event Subscriptions** and enable events.
3. Set **Request URL** to:
   - `https://<your-worker-domain>/slack/events`
4. Subscribe to bot events:
   - `message.im`
   - `reaction_added`
5. Disable **Socket Mode** (the app uses HTTP webhooks now).
6. Reinstall the app if Slack requests it.

## 7) Smoke test

1. DM the bot a simple request, for example: `list files in the repository`.
2. Verify the bot responds in-thread.
3. Trigger an approval-required command and react with 👍 or 👎.
4. Verify approval and denial flows are reflected in bot replies.

## 8) Persistence + safety checks

1. Complete a task that updates conversation history.
2. Wait for idle time, then send a follow-up in the same Slack thread.
3. Verify the agent retains context.
4. Attempt actions that exceed rate limits or target protected files.
5. Verify the action is blocked (or gated for approval) by policy.
