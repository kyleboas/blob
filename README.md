# Blob - Autonomous Coding Agent

Fully autonomous agent that works on GitHub repositories.

## Setup

```bash
wrangler kv:namespace create CONFIG
# Copy the ID into wrangler.toml

wrangler secret put GITHUB_TOKEN
wrangler secret put AI_GATEWAY_TOKEN  
wrangler secret put AI_GATEWAY_BASE_URL

# Deploy (single worker: includes Sandbox DO + container)
wrangler deploy
```

## API

```bash
# List repos
curl https://blob.your-account.workers.dev/repos

# Add repo
curl -X POST https://blob.your-account.workers.dev/repos -d '{"repo":"owner/repo"}'

# Set goals
curl -X POST https://blob.your-account.workers.dev/repos/owner/repo/goals -d '{"goals":["fix bugs"]}'

# Run now
curl -X POST https://blob.your-account.workers.dev/run
```

Runs automatically every 5 minutes.


## Codex OAuth login (Slack)

To make `login with codex` (or `login to codex`) work end-to-end, deploy the **single `blob-agent` worker** with its Sandbox DO + container binding, and point Slack at that worker.

### 1) Deploy the single worker

```bash
# blob-agent includes Slack routes, Sandbox DO, and the container config
wrangler deploy
```

In Cloudflare dashboard, this should appear as one Worker (`blob-agent`) with Durable Object bindings (`AGENT_DO`, `SANDBOX_DO`) plus a container named `sandbox`.

### 2) Configure required secrets

```bash
# required for Slack replies
wrangler secret put SLACK_BOT_TOKEN

# required for LLM/chat paths used by this bot
wrangler secret put AI_GATEWAY_TOKEN
wrangler secret put AI_GATEWAY_BASE_URL

# optional but commonly needed for repo actions
wrangler secret put GITHUB_TOKEN
```

### 3) Configure Slack app

- In Slack app settings, enable **Event Subscriptions**.
- Set Request URL to: `https://<your-main-worker>/slack/events`
- Subscribe to `message.channels` (and/or the message events you use).
- Install/reinstall the app to your workspace.

### 4) Trigger login from Slack

Send any of these exact messages in a channel where the bot is present:
- `login with codex`
- `login to codex`
- `codex login`
- `codex auth`
- `connect openai`

The bot returns a device URL + code. Open the URL, finish OAuth on your device, then reply:

```
done
```

That calls `/codex/auth/save`, which persists `~/.codex/auth.json` into `/workspace/.codex-auth/auth.json` in the sandbox container for reuse after restart.

### 5) Run Codex after login

```
run codex fix failing tests in this repo
```

If auth is missing, bot replies with not authenticated and asks you to login first.

### 6) Quick health/debug checks

```bash
# app route sanity
curl -i https://<your-main-worker>/repos

# sandbox health route (forwarded to Sandbox DO)
curl -i https://<your-main-worker>/health

# if login fails, tail logs for blob-agent
wrangler tail blob-agent
```

If you still only get “simulated login” text, your Slack event likely bypassed the Codex command path and fell through to generic chat. Verify the request reaches `/slack/events` and the message text is one of the login phrases above.
