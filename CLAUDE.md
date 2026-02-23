# Blob — Developer Guide

Blob is a self-modifying AI coding agent. It has a dual Python + TypeScript implementation:

- **Python** (`agent.py`, `slack_bot.py`, etc.) — the original ReAct loop, runs locally or on a VM
- **TypeScript** (`src/`) — the Cloudflare Workers port, runs as a distributed edge service using Durable Objects

> Note: `AGENT.md` is Blob's own operational knowledge base — it is injected into Blob's system prompt at runtime. It is not developer documentation. This file (`CLAUDE.md`) is the developer reference.

---

## Architecture

```
agent.py          ReAct loop and task orchestration
approval.py       Approval gate (auto / conditional / always-require)
safety.py         Git utilities, rate limiting, audit logging
sandbox.py        Sandboxed bash executor (timeout, output truncation)
config.py         Configuration and rate limit constants
slack_bot.py      Slack event handling and bot daemon
llm_client.py     Anthropic API client (retry, model routing)
tools.py          Tool schema definitions
github_tools.py   GitHub API client (create PRs, fork, remote URL)
blob_config.py    User preference management (blob_settings.json)

src/              TypeScript implementation (Cloudflare Workers)
  index.ts        Worker entrypoint
  agent.ts        Agent core logic
  approval.ts     Approval gate
  llm.ts          LLM client
  sandbox-client.ts  Sandbox HTTP client
  slack.ts        Slack integration
  storage.ts      Durable Objects storage layer
  safety.ts       Safety checks
  config.ts       Configuration
  tools.ts        Tool definitions
  types.ts        Shared type definitions

sandbox/          Separate Cloudflare Worker for sandboxed code execution
tasks.json        Self-improvement task queue
tasks/            PRDs and task breakdowns
```

---

## Running Tests

**Python tests** (pytest):
```bash
pytest tests/
pytest tests/ -v          # verbose
pytest tests/test_agent.py  # single file
```

**TypeScript tests** (Vitest + Cloudflare Workers pool):
```bash
npm test                  # type-check only (tsc --noEmit)
npm run test:watch        # run vitest in watch mode
```

---

## Environment Setup

Copy `.env.example` and fill in values:
```bash
cp .env.example .env
```

Required variables:
- `ANTHROPIC_API_KEY`
- `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (for Slack integration)
- `GITHUB_TOKEN` (PAT with `repo` scope, for PR creation)

---

## Running Blob Locally

```bash
python agent.py "your task here"    # single task
python agent.py --self-improve      # run next task from tasks.json
python slack_bot.py                 # start Slack daemon
```

---

## Deployment (Cloudflare Workers)

```bash
npm install
npx wrangler deploy                 # deploy main worker
npx wrangler deploy --config sandbox/wrangler.toml  # deploy sandbox worker
npx wrangler dev                    # local dev server
```

See `DEPLOY.md` for full deployment instructions including secrets and R2 setup.

---

## Protected Files (Constitution)

These files require explicit human approval before any modification:

```
agent.py  sandbox.py  approval.py  safety.py  config.py  slack_bot.py
```

Do not modify them without going through the approval workflow. All other files can be modified freely.

---

## Files Managed Automatically

Do not edit these manually:
- `.modify_count` — managed by rate limiter
- `.audit/*.jsonl` — append-only audit logs
- `AGENT.md` — updated automatically by Blob after self-improvement tasks

---

## Key Conventions

- Every file modification Blob makes is auto-committed
- Git tags (`checkpoint-{task_id}`) are created before risky tasks
- If `pytest tests/` fails after a self-improvement task, Blob reverts to the checkpoint
- Audit logs live in `.audit/` as append-only JSONL files
- Model routing: `claude-sonnet-4-5` for complex tasks, `claude-haiku-4-5` for routine tasks
