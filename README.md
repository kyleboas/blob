# Blob Pi Autonomy Worker

Blob is a Slack-driven autonomous coding worker built on Cloudflare Workers + Durable Objects + Cloudflare Sandbox.

## Overview

The runtime flow is:

1. Slack event is received at `/slack/events`.
2. Signature is validated and Slack is acknowledged quickly.
3. Conversation is deterministically routed to a Durable Object.
4. The DO manages job lifecycle and heartbeat-driven execution.
5. Pi agent executes work in Sandbox using only `read`, `write`, `edit`, and `bash` tools.
6. Results, memory, and status are persisted and reported to Slack.

## Prerequisites

- Node.js 20+
- npm
- Wrangler 4+
- Cloudflare account with Workers, Durable Objects, R2, AI, and Sandbox support
- Slack app + bot token

## Setup

```bash
npm install
npm run typecheck
npm test
```

Deploy sandbox worker:

```bash
wrangler deploy -c wrangler.sandbox.toml
```

Deploy agent worker:

```bash
wrangler deploy -c wrangler.agent.toml
```

## Environment variables and secrets

Set secrets on the **agent worker** unless noted.

- `SLACK_BOT_TOKEN` — required for Slack replies.
- `SLACK_SIGNING_SECRET` — required for Slack signature verification.
- `AI_GATEWAY_TOKEN` — required for model calls.
- `AI_GATEWAY_BASE_URL` — required for model gateway routing.
- `GITHUB_TOKEN` — required for GitHub API operations.
- `ACCOUNT_ID` — required for AI/run API calls.
- `GITHUB_REPO` — optional default repo.

Operational controls:

- `MAX_JOB_TOKENS` — per-job token budget.
- `MAX_HEARTBEAT_MODEL_CALLS` — max model calls per heartbeat cycle.
- `DAILY_TOKEN_CEILING` — daily aggregate cap.
- `CRON_FAIL_THRESHOLD` — alert threshold for consecutive cron failures.
- `CRON_STALL_MULTIPLIER` — expected cadence multiplier for stall detection.
- `config/runtime-controls.json` in GitHub — set `"paused": true` to pause cron and Slack task execution without redeploying.

## Slack configuration

1. Enable Event Subscriptions in your Slack app.
2. Set request URL to `https://<worker-domain>/slack/events`.
3. Subscribe to message events used by your workspace.
4. Install/reinstall app after scope changes.

## Docs

- `docs/architecture.md`
- `docs/cron-jobs.md`
- `docs/runbook.md`
- `tasks/prd-pi-autonomy.md`
- `tasks/tasks-pi-autonomy.md`
