# Deployment Guide (Fly.io + Slack Socket Mode)

## 1) Create and configure the Slack app

1. Create a new app at https://api.slack.com/apps.
2. Enable **Socket Mode** and create an app-level token with `connections:write` scope.
3. Under **OAuth & Permissions**, add bot token scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `groups:history`
   - `im:history`
   - `im:read`
   - `im:write`
   - `mpim:history`
   - `reactions:read`
   - `reactions:write`
4. Install the app to your workspace and copy:
   - `SLACK_BOT_TOKEN` (`xoxb-...`)
   - `SLACK_APP_TOKEN` (`xapp-...`)

## 2) Launch Fly app

```bash
flyctl launch --no-deploy
```

Use the provided `fly.toml` and confirm app name/region as needed.

## 3) Create persistent volume

```bash
flyctl volumes create agent_data --size 1 --region iad
```

The app mounts this volume at `/data` for repository state, `AGENT.md`, and cached docs.

## 4) Set secrets

```bash
flyctl secrets set \
  ANTHROPIC_API_KEY=... \
  SLACK_BOT_TOKEN=... \
  SLACK_APP_TOKEN=... \
  FLY_API_TOKEN=...
```

## 5) Deploy

```bash
flyctl deploy
```

## 6) Verify

```bash
flyctl status
flyctl logs
```

The app exposes `/healthz` and should show healthy checks once Socket Mode is connected.

## 7) Use from Slack

1. Invite the bot to a channel (or DM it).
2. Send a task (example: `list the files in the current directory`).
3. Watch progress and completion messages in the same thread.
4. For protected operations, approve/reject via `:white_check_mark:` / `:x:` reactions.
