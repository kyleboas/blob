# Operations Runbook

## Slack operator commands

Use these exact commands in a conversation with the bot (case-insensitive, trimmed):

- `settings` — show current verbosity and command hints.
- `set minimal` — reduce chatter to minimal mode (default).
- `set verbose` — enable per-tool ledger updates and short error summaries.
- `status` — inspect sandbox, workspace, tool ledger, and memory health.
- `selftest` — execute safe end-to-end health checks including R2 + Vectorize.

Keyword commands only trigger on exact matches. Example: `status please` is treated as a normal chat message.

## Interpreting `status`

`status` should include:

- Sandbox started/ready signal.
- Active repo workspace path (`/workspace/<repoDir>`).
- Recent tool calls (name, ok/fail, duration).
- Durable memory summary (last R2 flush timestamp + learned count/summary).
- Vectorize memory summary (last upsert result/timestamp + last query count/timestamp when available).

## Self-test expected behavior

`selftest` is designed to be safe and non-destructive:

1. Bootstraps repo workspace.
2. Exercises `read/write/edit/bash`.
3. Writes only under `.blob/selftest.txt` (and optional `.blob/selftest.log`).
4. Creates a learned memory record and verifies R2 persistence.
5. Generates embeddings via Workers AI, upserts into Vectorize, and queries for the inserted reference.
6. Reports pass/fail with concise detail.

If any step fails, inspect logs and binding configuration first.

## Required bindings and configuration

### Core secrets/bindings

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- Durable Object bindings used by the agent
- R2 bucket binding for durable memory artifacts
- Workers AI binding (`AI`) for embeddings
- Vectorize index binding (`PI_VECTORS`) for semantic memory

### Vectorize binding in Wrangler

Ensure `wrangler.agent.toml` defines the Vectorize binding and index:

```toml
[[vectorize]]
binding = "PI_VECTORS"
index_name = "<your-index-name>"
```

Use an embeddings model compatible with your Vectorize index dimensions.

## Common failure modes

### Missing Vectorize binding/index

Symptoms:
- `status` shows Vectorize unavailable or repeated upsert failures.
- `selftest` fails at upsert/query step.

Checks:
1. Confirm `[[vectorize]]` binding name is exactly `PI_VECTORS`.
2. Confirm `index_name` exists and is deployed in the target account/env.
3. Verify worker environment (dev/stage/prod) is using the expected Wrangler config.

### Embedding model/runtime errors

Symptoms:
- Upsert step skipped/fails due to embedding generation failure.
- Error references model mismatch or dimension incompatibility.

Checks:
1. Verify Workers AI binding (`AI`) is present.
2. Verify selected embedding model is available in the target account.
3. Ensure embedding dimensionality matches the Vectorize index definition.
4. Re-run `selftest` after correcting model/index compatibility.

### Sandbox auth/bootstrap failures

Symptoms:
- Repo clone/fetch/reset fails.
- Tool calls fail because workspace repo missing.

Checks:
1. Confirm Git auth path (`blob-git-askpass` + `GITHUB_TOKEN`) is configured.
2. Confirm repo URL and default branch assumptions (`main` fallback `master`).
3. Inspect bootstrap logs for git stderr excerpts.

### Slack events failing

Symptoms:
- 401 on `/slack/events`
- No bot response

Checks:
1. Verify `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are set.
2. Confirm Slack request URL matches deployed worker.
3. Inspect logs for signature validation failures.

## Reading alerts

Alert payload should include:

- job/cron name
- last error summary
- last success timestamp
- suggested operator action

If Slack posting fails, alerts are persisted in R2 at `alerts/YYYY-MM-DD.jsonl`.

## Debug with wrangler tail

Agent worker:

```bash
wrangler tail blob-agent -c wrangler.agent.toml
```

Sandbox worker:

```bash
wrangler tail blob-sandbox -c wrangler.sandbox.toml
```

## CI/unit test verification

PR CI runs tests via GitHub Actions workflow `.github/workflows/pr-tests.yml` using:

```bash
npm ci
npm test
```

Before opening a PR, run `npm test` locally to ensure new unit tests are included.

## Manual Slack smoke test checklist

Run this quick checklist in Slack after deployment:

1. Send `settings`; confirm default is `minimal`.
2. Send `set verbose`; run a tool-requiring request; confirm per-tool ledger lines appear.
3. Send `set minimal`; run a similar request; confirm ledger lines are suppressed.
4. Send `status`; confirm workspace path, recent tool calls, R2 flush info, and Vectorize fields are populated.
5. Send `selftest`; confirm pass and that `.blob/selftest.txt` is the only touched repo file.
6. Ask a follow-up referencing unique selftest text; confirm semantic recall works (Vectorize hit path).

## Incident triage sequence

1. Capture log reference IDs from Slack error messages.
2. Pull matching logs with `wrangler tail`.
3. Confirm whether issue is ingress, DO lifecycle, sandbox execution, memory (R2/Vectorize), or outbound Slack/API.
4. Mitigate (pause jobs, disable cron, rotate token, fix binding).
5. Backfill missing outputs and post status update.
