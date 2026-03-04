# Operations Runbook

## Common failure modes

### Slack events failing

Symptoms:
- 401 on `/slack/events`
- No bot response

Checks:
1. Verify `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are set.
2. Confirm Slack request URL matches deployed worker.
3. Inspect logs for `signature_invalid` and `handle_event_failed`.

### Durable Object job stalls

Symptoms:
- Jobs stuck queued/paused
- No progress updates

Checks:
1. Confirm alarm scheduling is active.
2. Verify job token/call budgets are not exhausted.
3. Inspect heartbeat logs and job transition events.

### Cron failures

Symptoms:
- Repeating failure alerts
- Missing expected outputs

Checks:
1. Review cron run start/end/failure logs.
2. Validate required env vars/secrets.
3. Check R2 write status for output artifacts.

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

## Manual cron trigger approach

Cloudflare cron events are platform-triggered. For manual testing:

1. Add a temporary diagnostic endpoint or test harness around the cron handler.
2. Invoke the same handler path used by `dispatchCronTask`.
3. Remove the temporary harness before merging.

## Incident triage sequence

1. Capture log reference IDs from Slack error messages.
2. Pull matching logs with `wrangler tail`.
3. Confirm whether issue is ingress, DO lifecycle, sandbox execution, or outbound Slack/API.
4. Mitigate (pause jobs, disable cron, rotate token).
5. Backfill missing outputs and post status update.
