# Cron Jobs Guide

## Current model

Blob uses Wrangler cron triggers for heavy periodic work while interactive execution is kept in Durable Object heartbeats.

Configured crons are declared in `wrangler.agent.toml`.

## How to add a cron job

1. Add a new `[[triggers.crons]]` entry in `wrangler.agent.toml`.
2. Add routing logic in `src/cron-jobs.ts` via `dispatchCronTask`.
3. Implement the task handler in the appropriate subsystem.
4. Add or update tests (`src/cron-jobs.test.ts` and subsystem tests).
5. Deploy agent worker.

## How to remove a cron job

1. Remove the cron stanza from `wrangler.agent.toml`.
2. Remove or deprecate corresponding handler logic in `src/cron-jobs.ts`.
3. Remove stale tests/fixtures.
4. Deploy agent worker.

## Scan target configuration

Scan targets are data-configured in R2 using `config/scan-targets.json`.

Schema:

```json
{
  "sources": [
    {
      "name": "example-source",
      "type": "rss|github|web",
      "url": "https://...",
      "cadence_override": "optional cron",
      "params": {}
    }
  ]
}
```

This allows adding/removing scan sources without code changes.

## Validation checklist

- Cron expression is valid.
- Handler is idempotent.
- Observability events emitted at start/end/failure.
- Alerts are produced for repeated failures/stalls.
- Secrets are redacted in logs.
