# /tasks/tasks-blob-sandbox-refactor.md

## Relevant Files

- `src/index.ts` — Worker entrypoint: Slack Events API handler, cron trigger dispatcher, and routing.
- `src/durable/*` — Durable Object: agent brain, job model, SQLite state, heartbeat alarm.
- `src/sandbox/*` — Sandbox client, workspace lifecycle (provisioning, teardown, state persistence).
- `src/tools/*` — `read/write/edit/bash` tool adapters with safety limits and retry logic.
- `src/agent/*` — Pi-style tool loop, prompt assembly, Retrieved Memory injection, budget enforcement.
- `src/workspace/state.ts` — Workspace state helpers for `/workspace/blob_state/log.jsonl` and `context.jsonl`.
- `src/workspace/daily_learned.ts` — Daily learned flush: model-call-based extraction, JSONL writer, R2 upload.
- `src/memory/*` — R2 memory items, Vectorize index, recall, ingestion validation, compaction, reconciliation.
- `src/services/*` — R2, Vectorize, embeddings, logging, secret redaction helpers.
- `src/github/*` — Git operations in Sandbox + GitHub API wrapper (PR, merge, conflict detection).
- `src/deploy/*` — Deploy trigger + deploy status polling + Slack reporting.
- `src/scheduler/heartbeat.ts` — Heartbeat alarm: job resumption, health checks, daily summary.
- `src/scheduler/cron/*` — Cron handlers: compaction, reconciliation, content-scan, others.
- `src/alerts/*` — Cron failure tracking, stall detection, Slack alerting, R2 fallback logging.
- `src/cost/*` — Token tracking, per-job budgets, per-heartbeat limits, daily ceiling enforcement.
- `wrangler*.toml` — Bindings for DO, Sandbox, R2, Vectorize, AI, secrets, cron triggers.
- `config/scan-targets.json` — R2-hosted scan target definitions (added/removed without code changes).
- `README.md` / `docs/*` — Architecture diagram, setup guide, happy-path walkthrough.
- `src/**/*.test.ts` — Unit tests and integration test scaffolding.

### Notes

- Unit tests should be placed alongside the code files they test.
- Use `npx jest [optional/path/to/test/file]` to run tests.
- PRD reference: `/tasks/prd-blob-sandbox-refactor.md`

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, check it off by changing `- [ ]` to `- [x]`.

Update this file after completing each sub-task.

-----

## Tasks

### Phase 0: Setup

- [x] 0.0 Create feature branch
  - [x] 0.1 Create and checkout `refactor/blob-sandbox-refactor`

### Phase 1: Audit and Architecture

- [x] 1.0 Repository audit: identify and classify legacy code to remove
  - [x] 1.1 Map current runtime entrypoints (Worker fetch handler, DO alarm, Sandbox sessions, scheduled triggers)
  - [x] 1.2 Identify duplicate/obsolete agent loops and tool implementations
  - [x] 1.3 Identify “Workers-only pseudo-tools” or HTTP-template tool layers to delete
  - [x] 1.4 Identify unused configs, scripts, dependencies, and dead code not referenced by any entrypoint
  - [x] 1.5 Produce `/tasks/legacy-delete-plan.md` with files/modules + rationale for each deletion
- [x] 2.0 Define target architecture and module boundaries
  - [x] 2.1 Document canonical request flow: Slack → Worker → DO → Sandbox → tools → model loop → Slack response
  - [x] 2.2 Document DO keying rules: `team_id:channel_id:thread_ts` for threads, `team_id:channel_id:channel` for top-level, `team_id:user_id:dm` for DMs
  - [x] 2.3 Document tool surface: `read/write/edit/bash` only — no other tools
  - [x] 2.4 Document scheduling model: DO alarm heartbeat (10 min) + `wrangler.toml` cron triggers for heavy tasks
  - [x] 2.5 Document memory architecture: workspace state (ephemeral) → R2 (source of truth) → Vectorize (semantic index) → daily learned flush → compaction
  - [x] 2.6 Document cost control model: per-job token budget, per-heartbeat call limit, daily aggregate ceiling, all configurable via env vars
  - [x] 2.7 Write architecture diagram and happy-path walkthrough in `docs/architecture.md`

### Phase 2: Core Infrastructure

- [x] 3.0 Slack ingestion and DO routing
  - [x] 3.1 Implement Slack signature verification + 3-second ack (PRD 4.2.1)
  - [x] 3.2 Implement deterministic DO routing keys per the keying rules in 2.2 (PRD 4.2.2–4.2.3)
  - [x] 3.3 Define thread-to-channel state migration behavior (copy-on-first-thread-message vs. lazy lookup) and implement chosen approach (PRD 4.2.4)
  - [x] 3.4 Implement Slack posting utilities for progress updates, final summaries, and error messages (PRD 4.2.5)
  - [x] 3.5 Add tests for: routing key derivation (all three patterns), Slack signature verification, and ack timing
- [x] 4.0 DO job model + heartbeat
  - [x] 4.1 Implement job schema in DO SQLite: id, status (queued → running → paused → completed | failed), created_at, updated_at, resume_state (current step, tool history, partial outputs, sandbox_id), token_usage, model_call_count (PRD 4.3.1–4.3.3)
  - [x] 4.2 Implement job lifecycle transitions with validation (e.g., only running → paused, not queued → completed)
  - [x] 4.3 Implement max job duration enforcement: configurable wall-clock limit (default 30 min), force-pause on breach (PRD 4.3.4)
  - [x] 4.4 Implement heartbeat as DO alarm that re-schedules itself every 10 minutes (PRD 4.9.1)
  - [x] 4.5 Heartbeat logic: resume paused jobs with remaining budget, start queued jobs oldest-first, respect per-heartbeat model call limit (PRD 4.9.2)
  - [x] 4.6 Heartbeat must not run heavy workloads directly — defer jobs exceeding cycle budget (PRD 4.9.3)
  - [x] 4.7 Implement daily summary posting: once per day on first heartbeat after midnight UTC if configured (PRD 4.9.2)
  - [x] 4.8 Add tests for: lifecycle transitions, pause/resume with state, budget enforcement, heartbeat scheduling
- [ ] 5.0 Sandbox lifecycle + Pi 4 tools
  - [ ] 5.1 Implement sandbox provisioning: create on first tool call for a sandboxId, reuse if exists (PRD 4.4.4)
  - [ ] 5.2 Implement sandbox idle timeout: eligible for teardown after configurable duration (default 60 min) with no tool calls (PRD 4.4.5)
  - [ ] 5.3 Implement pre-teardown state persistence: save `/workspace/blob_state/*` to R2; restore into fresh sandbox on next activation (PRD 4.4.6)
  - [ ] 5.4 Implement sandbox cleanup policy: configurable per job type — destroy on completion, keep on failure for debugging (PRD 4.4.7)
  - [ ] 5.5 Implement `bash` tool: timeout enforcement, max output capture, exit status, allowed command patterns (PRD 4.4.3)
  - [ ] 5.6 Implement `read` tool: path allowlist, max file size (PRD 4.4.3)
  - [ ] 5.7 Implement `write` tool: path allowlist, max file size, atomic write (PRD 4.4.3)
  - [ ] 5.8 Implement `edit` tool: deterministic text replacement, path allowlist, size limits (PRD 4.4.3)
  - [ ] 5.9 Implement workspace state helpers for `log.jsonl` and `context.jsonl` (PRD 4.6.1)
  - [ ] 5.10 Add tests for: tool adapters (mocked sandbox client), sandbox provisioning/reuse, state persistence round-trip, safety limit enforcement
- [ ] 6.0 Agent loop + error handling + cost control
  - [ ] 6.1 Implement tool loop: build model input (system prompt + Retrieved Memory + conversation) → execute tool calls → append results → stop on no tool calls or budget hit (PRD 4.5.1)
  - [ ] 6.2 Implement streaming output and periodic Slack progress updates (PRD 4.5.2)
  - [ ] 6.3 Implement retry policy — `bash`: up to 2 retries with 5s backoff for transient errors, no retry for deterministic failures; `read/write/edit`: 1 retry on I/O errors, immediate fail on schema/path errors (PRD 4.5.3)
  - [ ] 6.4 On tool failure after retries: append failure to context, let model decide next action (PRD 4.5.3)
  - [ ] 6.5 Implement max consecutive tool failures per job: default 5, configurable — pause job and notify Slack on breach (PRD 4.5.4)
  - [ ] 6.6 Implement per-job token budget: default 100k input + 20k output — inject warning at 90%, halt and pause at 100% (PRD 4.5.5)
  - [ ] 6.7 Implement per-heartbeat model call limit: default 10 calls across all jobs (PRD 4.5.6)
  - [ ] 6.8 Implement daily aggregate token ceiling: default 500k — pause non-critical jobs when hit, optional reserve budget for critical jobs (PRD 4.5.7)
  - [ ] 6.9 Token tracking: record usage per job and per day in DO state, expose in logs (PRD 4.5.5–4.5.7)
  - [ ] 6.10 Add tests for: retry logic per tool type, consecutive failure threshold, token budget warnings and halts, daily ceiling enforcement

### Phase 3: Memory System

- [x] 7.0 Layered memory: R2 + Vectorize + recall + ingestion
  - [x] 7.1 Define memory item schema for R2 at `mem/<id>.json`: id, scope, content, created_at, updated_at, source (thread | cron | compaction), version (PRD 4.6.2)
  - [x] 7.2 Implement R2 memory store: create, read, update, delete, list by prefix (PRD 4.6.2)
  - [x] 7.3 Implement embeddings helper using Workers AI (PRD 4.6.3)
  - [x] 7.4 Implement Vectorize wrapper: upsert (id, embedding, minimal metadata: id/scope/created_at/label), query by embedding, delete (PRD 4.6.3)
  - [x] 7.5 Implement recall: embed query → Vectorize nearest-neighbor → R2 fetch → inject as Retrieved Memory block (PRD 4.6.4)
  - [x] 7.6 Implement scope-priority retrieval: thread → channel → team, merge and deduplicate by content hash (PRD 4.6.5)
  - [x] 7.7 Enforce recall limits: max 10 items, max 4k tokens retrieved per query (configurable) (PRD 4.6.6)
  - [x] 7.8 Implement ingestion validation: reject secrets (pattern match), reject duplicates (cosine similarity > 0.95), reject oversized items (> 2k tokens) (PRD 4.6.7)
  - [x] 7.9 Implement atomic-as-possible write: R2 first, then Vectorize — if Vectorize fails, mark R2 item as unindexed for later retry (PRD 4.6.8)
  - [x] 7.10 Add tests for: recall merging and dedup, scope priority, ingestion validation (secrets, duplicates, size), unindexed item marking
- [x] 8.0 Daily learned flush
  - [x] 8.1 Implement the dedicated model call for learned extraction: constrained prompt that outputs JSONL with timestamp, scope, category (decision | fact | preference | lesson), content (one sentence), confidence (high | medium | low) (PRD 4.6.9)
  - [x] 8.2 Implement JSONL writer for `/workspace/blob_state/daily/YYYY-MM-DD.learned.jsonl` — append-only, create if not exists (PRD 4.6.10)
  - [x] 8.3 Apply secret redaction filter to all learned entries before writing (PRD 4.6.11)
  - [x] 8.4 Wire: trigger learned flush before every context compaction (PRD 4.6.9)
  - [x] 8.5 Implement unconditional upload of daily learned entries to R2 at `daily/YYYY-MM-DD.learned.jsonl` after each flush (PRD 4.6.12)
  - [x] 8.6 Add tests for: model prompt output parsing, secret redaction, append behavior, R2 upload
- [x] 9.0 Memory compaction + retention + reconciliation
  - [x] 9.1 Implement retention thresholds: max 500 items per scope, max 90 days age, max 50MB total in R2 (all configurable) (PRD 4.6.13)
  - [x] 9.2 Implement compaction: model call to summarize/merge related items within scope → replace originals in R2 → update Vectorize (delete old, insert new) → log the operation (PRD 4.6.14)
  - [x] 9.3 Implement Vectorize/R2 consistency reconciliation: find Vectorize entries pointing to missing R2 objects (delete from Vectorize), find unindexed R2 items (re-index into Vectorize), log all corrections (PRD 4.6.16)
  - [x] 9.4 Add tests for: retention threshold detection, compaction replacement logic, reconciliation of orphaned entries

### Phase 4: GitHub + Deploy

- [x] 10.0 GitHub PR automation
  - [x] 10.1 Implement configurable repo/branch settings per channel or team in R2 config or DO state (PRD 4.7.1)
  - [x] 10.2 Implement repo operations in Sandbox: clone, checkout base branch, create feature branch (PRD 4.7.1)
  - [x] 10.3 Implement pre-push: fetch latest base branch, rebase/merge — on conflict, post Slack message describing conflicts, pause job, await user instruction (retry, force-push, or abort) (PRD 4.7.2)
  - [x] 10.4 Implement pre-push secret scan: diff against secret patterns, block push if match found (PRD 4.7.3)
  - [x] 10.5 Implement commit + push + PR creation via GitHub API with idempotency key (branch name + commit hash) (PRD 4.7.3–4.7.4)
  - [x] 10.6 Post PR link to Slack (PRD 4.7.4)
  - [x] 10.7 Implement optional auto-merge: poll/webhook for CI checks → merge on pass → post result; on CI failure, post summary and pause (PRD 4.7.5)
  - [x] 10.8 Implement multi-repo support: model or user specifies target repo, ask for clarification in Slack if ambiguous (PRD 4.7.6)
  - [x] 10.9 Add tests for: GitHub API wrapper (mocked), idempotency keys, conflict detection flow, secret scan blocking
- [x] 11.0 Deploy hooks + status reporting
  - [x] 11.1 Implement deploy trigger: configurable mechanism per repo — webhook URL, GitHub Actions dispatch, or Cloudflare Pages deploy hook (PRD 4.8.1)
  - [x] 11.2 Implement deploy status polling with configurable timeout (default 10 min) (PRD 4.8.2)
  - [x] 11.3 Report deploy status to Slack: success, failure, or timeout (PRD 4.8.2)
  - [x] 11.4 If deploy mechanism not configured, skip deploy step and notify Slack that manual deploy is needed (PRD 4.8.3)
  - [x] 11.5 Implement idempotency for deploy triggers (keyed on merge SHA) to prevent double-deploy on retries (PRD 4.8.1)
  - [x] 11.6 Add tests for: trigger payload generation, idempotency, timeout handling

### Phase 5: Cron + Alerts

- [x] 12.0 Cron jobs
  - [x] 12.1 Add cron triggers to `wrangler.toml` and implement dispatcher in Worker fetch/scheduled handler (PRD 4.9.4–4.9.5)
  - [x] 12.2 Implement cron execution pattern: create isolated sandbox session → run task → store results to R2 → post Slack summary → record outcome in DO state (status, duration, last_run_at, last_error, output_summary) (PRD 4.9.5)
  - [x] 12.3 Implement `content-scan` cron: read scan targets from `config/scan-targets.json` in R2, run scan, persist findings to R2 memory items, post Slack summary (PRD 4.9.6)
  - [x] 12.4 Implement `memory-compaction` cron: invoke compaction logic from task 9.2 (PRD 4.9.6)
  - [x] 12.5 Implement `memory-reconciliation` cron: invoke reconciliation logic from task 9.3 (PRD 4.9.6)
  - [x] 12.6 Add tests for: cron dispatcher routing, isolated session creation, outcome recording
- [x] 13.0 Fallback alerts
  - [x] 13.1 Implement cron outcome tracking in DO state: job_name, status (success | failure | running), last_run_at, last_success_at, last_error, consecutive_failures (PRD 4.10.1)
  - [x] 13.2 Implement immediate Slack alert on cron failure (configurable per job) (PRD 4.10.2)
  - [x] 13.3 Implement heartbeat detection: consecutive failures ≥ N (default 3, env var `CRON_FAIL_THRESHOLD`) and stall detection (no run within 2× expected cadence, env var `CRON_STALL_MULTIPLIER`) (PRD 4.10.3)
  - [x] 13.4 Implement Slack alert payload: job name, last error summary, last success timestamp, suggested next action (PRD 4.10.4)
  - [x] 13.5 Implement R2 fallback logging at `alerts/YYYY-MM-DD.jsonl` if Slack posting fails (PRD 4.10.5)
  - [x] 13.6 Add tests for: threshold detection, stall detection, alert payload construction, R2 fallback on Slack failure

### Phase 6: Observability + Safety

- [x] 14.0 Observability
  - [x] 14.1 Implement structured JSON logging for: Slack ingest, job lifecycle, tool call timing/outcome, memory ops, GitHub ops, deploy ops, heartbeat runs, cron runs (PRD 4.11.1)
  - [x] 14.2 Include log reference IDs in all Slack error messages so operators can trace issues (PRD 4.11.3)
  - [x] 14.3 Log token usage per job and per day for cost monitoring (PRD 4.5.5–4.5.7)
- [x] 15.0 Secret redaction + safety
  - [x] 15.1 Implement configurable secret pattern list (API keys, tokens, passwords, private keys) used across all subsystems (PRD 4.11.2)
  - [x] 15.2 Apply redaction in: logs, memory ingestion, daily learned flush, GitHub commit diffs, Slack messages (PRD 4.11.2)
  - [x] 15.3 Implement catch-all exception handler in Worker: report generic error to Slack with log reference ID, never expose stack traces (PRD 4.11.3)
  - [x] 15.4 Add tests for: pattern matching against known secret formats, redaction in each subsystem
- [x] 16.0 GitHub API rate limit handling
  - [x] 16.1 Track remaining GitHub API quota from response headers (PRD 7)
  - [x] 16.2 Warn when below 10% remaining; implement backoff when rate-limited (PRD 7)

### Phase 7: Cleanup + Documentation

- [x] 17.0 Delete legacy code
  - [x] 17.1 Remove all files/modules listed in `/tasks/legacy-delete-plan.md`
  - [x] 17.2 Remove unused dependencies from `package.json`
  - [x] 17.3 Remove obsolete config files and scripts
  - [x] 17.4 Verify no dangling imports or references remain — build must pass clean
- [x] 18.0 Documentation
  - [x] 18.1 Write `README.md`: project overview, prerequisites, setup steps, env var reference, deployment
  - [x] 18.2 Write `docs/architecture.md`: request flow diagram, module boundaries, DO keying rules, memory architecture, scheduling model, cost control
  - [x] 18.3 Write `docs/cron-jobs.md`: how to add/remove/configure cron jobs and scan targets
  - [x] 18.4 Write `docs/runbook.md`: common failure modes, how to read alerts, how to debug with `wrangler tail`, how to manually trigger cron jobs
- [ ] 19.0 Final validation
  - [x] 19.1 Run full test suite — all tests pass
  - [ ] 19.2 Build and deploy to staging — no errors
  - [ ] 19.3 Manual smoke test checklist:
    - [ ] 19.3.1 Slack message → Blob responds with tool usage
    - [ ] 19.3.2 Slack request → PR created → PR link posted to Slack
    - [ ] 19.3.3 Auto-merge enabled → merge triggers deploy → deploy status posted to Slack
    - [ ] 19.3.4 Memory recall: Blob references a previous decision without being reminded
    - [ ] 19.3.5 Cron job runs → results in R2 → Slack summary posted
    - [ ] 19.3.6 Simulate cron failure 3× → Slack alert fires with correct payload
    - [ ] 19.3.7 Hit daily token ceiling → non-critical jobs pause → Slack notification
    - [ ] 19.3.8 Push with embedded secret → push blocked → Slack notification
  - [x] 19.4 Verify no legacy code remains: grep for known legacy module names, confirm zero matches