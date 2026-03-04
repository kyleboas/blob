# PRD: Blob Sandbox Refactor

## 1. Introduction/Overview

This project is a refactor of the existing repository: https://github.com/kyleboas/blob.

Blob is a self-building agentic Slack assistant deployed on Cloudflare Workers + Durable Objects + Cloudflare Sandbox. It follows Pi Mono’s “4 tools” philosophy by exposing only:

- `read` (files)
- `write` (files)
- `edit` (deterministic text replacement)
- `bash` (shell execution)

Blob runs real work inside a Sandbox Linux workspace (clone repos, run tests, generate diffs) and supports:

- Slack → Worker router → Durable Object agent state → Sandbox workspace
- Layered memory using minimal workspace state files, R2 as the source-of-truth for full memory items, and Vectorize as the semantic index
- Cost control via 10-minute heartbeats for lightweight work and job resumption, separate cron jobs for heavy tasks in isolated sessions, and hard token/spending budgets
- GitHub PR automation (create PR, optional auto-merge, deploy trigger + deploy status reporting to Slack)
- Safety/observability including fallback alerts when cron jobs fail silently

This refactor removes all legacy code from the existing repo: old/duplicate runtime paths, unused frameworks, and obsolete execution/tooling approaches. The final codebase will have a single coherent “Sandbox-first” architecture with clear boundaries and minimal surface area.

-----

## 2. Goals

1. **Single coherent architecture** — One execution path: Sandbox-first with the 4 tools. Legacy/unused code paths are deleted, not deprecated.
1. **End-to-end autonomy loop** — From Slack, Blob can implement changes in a repo → commit/push → open PR. When enabled: auto-merge + deploy trigger + deploy-status reporting back to Slack.
1. **Balanced scheduling model** — Heartbeat runs lightweight orchestration and health checks. Heavy tasks run via dedicated cron jobs in isolated sessions.
1. **Layered memory with daily learned flush + compaction** — No `MEMORY.md` or `SKILLS/`. Before each context compaction, a dedicated model call summarizes what was learned into a daily file. Memory growth is bounded via retention + compaction.
1. **Cost control** — Hard limits on token usage per job, model calls per heartbeat cycle, and daily aggregate spending. All limits configurable via environment variables.
1. **Fallback alerts** — If cron jobs fail or stall, the heartbeat detects and alerts before failures stack up.

-----

## 3. User Stories

1. As a Slack user, I can message Blob and get a PR back for a change request.
1. As a Slack user, I can ask Blob to merge and deploy, and I receive status updates in Slack.
1. As a Slack user, Blob remembers key decisions and context without me repeating myself.
1. As an operator, heavy scanning jobs run separately so they don’t bloat the main agent context.
1. As an operator, I get alerted if cron jobs fail silently or keep failing repeatedly.
1. As an operator, I can see token and cost usage per job and per day, and the system halts gracefully when budgets are hit.
1. As a maintainer, I can understand the codebase quickly because legacy paths are removed and there is one documented happy path.

-----

## 4. Functional Requirements

### 4.1 Refactor + Legacy Removal

1. The system must include an explicit legacy audit step that identifies: old/unused tool implementations, duplicate agent loops, deprecated “Workers-only” pseudo-tool layers, unused configuration files and scripts, and dead code not referenced by any runtime entrypoint.
1. The system must delete legacy code and update all imports/references accordingly.
1. The system must have one documented “happy path” architecture diagram and entrypoints.

### 4.2 Slack Ingestion + Routing

1. The system must verify Slack signatures and ack within 3 seconds.
1. The system must route events to a Durable Object instance using a deterministic key.
1. The keying rules are:
- Threaded messages: `team_id:channel_id:thread_ts`
- Top-level channel messages: `team_id:channel_id:channel`
- DMs: `team_id:user_id:dm`
1. A message that starts a new thread must migrate state from the channel-level DO if relevant context exists. The migration mechanism must be defined (copy-on-first-thread-message vs. lazy lookup).
1. The system must post status updates and final results to Slack.

### 4.3 Durable Object Agent + Job Model

1. The DO must store job state in DO SQLite.
1. The DO must support job lifecycle: `queued → running → paused → completed | failed`.
1. The DO must persist resume state so jobs continue across heartbeats, including: current step, tool call history, partial outputs, and the sandbox ID to reconnect to.
1. The DO must enforce a maximum job duration (configurable, default 30 minutes wall clock) after which the job is force-paused or failed.

### 4.4 Sandbox Lifecycle + Pi 4 Tools

1. The system must implement `read/write/edit/bash` backed by Sandbox operations.
1. The workspace must be isolated per thread (sandboxId derived from the DO key).
1. Tool safety limits must exist: allowed paths, max file size (bytes), max bash runtime, timeout kills.
1. Sandbox provisioning: a new Sandbox is created on first tool call for a given sandboxId. If a Sandbox already exists for that ID, it must be reused.
1. Sandbox idle timeout: Sandboxes that have had no tool calls for a configurable duration (default 60 minutes) must be eligible for teardown.
1. Before teardown, the system must persist workspace state files (`/workspace/blob_state/*`) to R2. On next activation, the system must restore these files into a fresh Sandbox.
1. Sandbox cleanup: on job completion or failure, the system must decide whether to keep or destroy the Sandbox (configurable per job type, default: destroy on completion, keep on failure for debugging).

### 4.5 Agent Loop + Error Handling

1. The system must implement a tool loop that: builds model input (system prompt + Retrieved Memory + conversation), executes tool calls, appends tool results, and stops when the model emits no tool calls or budgets are hit.
1. The system must support streaming output and Slack progress updates.
1. Retry policy for tool failures:
- `bash`: retry up to 2 times with 5-second backoff for transient errors (exit codes indicating timeout or resource contention). Non-transient failures (exit code 1 with deterministic output) do not retry.
- `read/write/edit`: retry once on I/O errors. Schema/path errors fail immediately.
- If a tool fails after retries, the failure is appended to context and the model decides whether to try an alternative approach or abort.
1. Max consecutive tool failures per job: 5 (configurable). On breach, the job is paused and Slack is notified.
1. Per-job token budget: configurable, default 100k input + 20k output tokens. When 90% consumed, the system injects a warning into model context. At 100%, the loop halts and the job is paused.
1. Per-heartbeat model call limit: configurable, default 10 model calls per heartbeat cycle across all jobs.
1. Daily aggregate token ceiling: configurable, default 500k tokens. When hit, all non-critical jobs pause until the next day. Critical jobs (e.g., deploy-status checks) may use a separate reserve budget.

### 4.6 Layered Memory

**Workspace state (minimal, ephemeral)**

1. The system must maintain `/workspace/blob_state/log.jsonl` (append-only action log) and `/workspace/blob_state/context.jsonl` (current conversation context).

**Durable memory (R2 + Vectorize)**

1. The system must store durable memory items in R2 at `mem/<id>.json`. Each item must include: id, scope, content, created_at, updated_at, source (thread/cron/compaction), and a version counter.
1. The system must store semantic index entries in Vectorize with embeddings pointing to R2 IDs. Vectorize metadata must contain only: id, scope, created_at, and a short label (within Vectorize’s metadata size limits). Full content lives in R2 only.

**Recall**

1. On inbound Slack messages, the system must: embed the query → Vectorize nearest-neighbor query → R2 fetch matched items → inject as a “Retrieved Memory” block in model input.
1. Retrieval must follow scope priority: thread → channel → team. Results are merged and deduplicated by content hash.
1. Max retrieved items per query: configurable, default 10. Total retrieved memory token budget: configurable, default 4k tokens.

**Ingestion**

1. The model may suggest `remember_items[]` in its output. The system must validate each item: reject items containing secrets (pattern match for API keys, tokens, passwords), reject duplicates (cosine similarity > 0.95 against existing Vectorize entries), and reject items exceeding max size (default 2k tokens).
1. Accepted items are written to R2 and indexed in Vectorize in a single atomic-as-possible operation (write R2 first, then Vectorize; if Vectorize fails, mark the R2 item as unindexed for later retry).

**Daily learned flush**

1. Before each context compaction, the system must invoke a dedicated model call with a constrained prompt: “Given the conversation log below, extract a list of facts, decisions, and lessons learned. Output JSONL only, one object per line. Each object must have: timestamp, scope, category (decision | fact | preference | lesson), content (one sentence), and confidence (high | medium | low). Do not include secrets or ephemeral operational details.”
1. The output is written to `/workspace/blob_state/daily/YYYY-MM-DD.learned.jsonl`, appending if the file already exists.
1. The daily file must not contain raw secrets (enforced by the same pattern-match filter as ingestion).
1. Daily learned entries must always be uploaded to R2 at `daily/YYYY-MM-DD.learned.jsonl` regardless of workspace persistence settings. The upload cost is negligible and workspace persistence on Cloudflare Sandbox is not guaranteed.

**Compaction and retention**

1. The system must implement retention thresholds: max items per scope (default 500), max age (default 90 days), max total memory size (default 50MB in R2).
1. Compaction must: invoke a model call to summarize/merge related items within the same scope, replace the original items with the summary item in R2, update Vectorize (delete old embeddings, insert new one), and log the compaction operation.
1. Compaction must run as a scheduled cron job, not inline during interactive requests.

**Consistency reconciliation**

1. A weekly cron job must check for orphaned entries: Vectorize entries pointing to missing R2 objects (delete from Vectorize), and R2 items marked as unindexed (re-index into Vectorize). The reconciliation must log all corrections.

### 4.7 GitHub PR Automation

1. The system must clone the configured repo and create a feature branch in the Sandbox. The target repo and default base branch must be configurable per channel or team (stored in R2 config or DO state).
1. Before pushing, the system must fetch the latest base branch and rebase or merge. If conflicts are detected, the system must: post a Slack message describing the conflicts, pause the job, and wait for user instruction (retry, force-push, or abort).
1. The system must commit and push changes. Commits must not contain secrets (pre-push scan of diff against secret patterns).
1. The system must open a PR via GitHub API and post the PR link to Slack.
1. If auto-merge is enabled, the system must poll or webhook-listen for CI checks to pass, then merge. If checks fail, post the failure summary to Slack and pause.
1. Multi-repo: the system must support configuring multiple repos. The model or the user must specify which repo a task targets. If ambiguous, the system must ask for clarification via Slack.

### 4.8 Deploy Hooks + Status Reporting

1. The system must trigger a deploy after merge via a configurable mechanism: webhook URL, GitHub Actions dispatch, or Cloudflare Pages deploy hook.
1. The system must poll or listen for deploy status and report back to Slack (success, failure, or timeout after configurable duration, default 10 minutes).
1. Deploy hooks are best-effort. If the deploy mechanism is not configured, the system must skip the deploy step and notify Slack that manual deploy is needed.

### 4.9 Scheduling: Heartbeat + Cron Isolation

**Heartbeat (Durable Object alarm, every 10 minutes)**

1. The heartbeat is implemented as a DO alarm that re-schedules itself.
1. The heartbeat must: resume paused jobs that have remaining budget, start queued jobs (oldest first, respecting per-heartbeat model call limits), run health checks on cron job status (see 4.10), and post a daily summary to Slack if configured (once per day, on first heartbeat after midnight UTC).
1. The heartbeat must not run heavy workloads directly. If a queued job is estimated to exceed the heartbeat cycle budget, it must be deferred to the next cycle or broken into smaller steps.

**Cron jobs (Cloudflare cron triggers)**

1. Cron jobs are defined in `wrangler.toml` as standard Cloudflare cron triggers. Each cron trigger maps to a handler function in the Worker.
1. Each cron job must: create its own isolated Sandbox session (separate sandboxId from interactive sessions), execute its task, store results as R2 memory items and/or artifacts, post a Slack summary on completion, and record its outcome in DO state (status, duration, last_run_at, last_error, output_summary).
1. The initial cron jobs are:
- `content-scan` (cadence: configurable, default daily): scans configured sources and stores findings. Sources and scan parameters are defined in an R2 config file at `config/scan-targets.json` so they can be added or removed without code changes.
- `memory-compaction` (cadence: weekly): runs the compaction logic from 4.6.13–14.
- `memory-reconciliation` (cadence: weekly): runs the consistency check from 4.6.16.
1. New cron jobs can be added by: adding a cron trigger in `wrangler.toml`, adding a handler function, and adding a config entry in R2 if the job needs runtime parameters.

### 4.10 Fallback Alerts

1. The system must track cron job outcomes in DO state: job_name, status (success | failure | running), last_run_at, last_success_at, last_error, consecutive_failures.
1. On cron failure, the system must either notify Slack immediately or mark it for heartbeat escalation (configurable per job).
1. The heartbeat must detect: cron jobs that have failed N consecutive times (default N=3, configurable via env var `CRON_FAIL_THRESHOLD`), and cron jobs that have not run within their expected window (stall detection: 2× the expected cadence, configurable via env var `CRON_STALL_MULTIPLIER`).
1. On detection, the system must post a Slack alert with: which cron/job failed, last error summary, when it last succeeded, and suggested next action (link to logs if available, or “check wrangler tail”).
1. If Slack posting itself fails (e.g., token expired), the system must log the alert to R2 at `alerts/YYYY-MM-DD.jsonl` as a fallback.

### 4.11 Observability + Safety

1. Structured JSON logs for: Slack ingest events, job lifecycle transitions, tool call timing and outcomes, memory operations (store, recall, compact), GitHub operations (clone, push, PR, merge), deploy operations, heartbeat runs (jobs processed, health check results), and cron runs (start, end, status, duration).
1. All logs and memory items must be scanned for secrets using a configurable pattern list (API keys, tokens, passwords, private keys). Matches must be redacted before storage or logging.
1. The system must fail safely: tool errors produce helpful Slack messages rather than stack traces, and unhandled exceptions in the Worker are caught and reported to Slack with a generic error message plus a log reference ID.

-----

## 5. Non-Goals (Out of Scope)

1. OAuth onboarding — manual secrets only for this phase.
1. A web UI or admin dashboard.
1. Advanced semantic clustering/dedup beyond cosine similarity threshold.
1. Full CI/CD provider management — best-effort hooks only.
1. Multi-tenant isolation — single team deployment for now.
1. Streaming tool output to Slack in real time (progress updates are periodic, not streamed).

-----

## 6. Design Considerations

- Keep tool surface area fixed at four tools. New capabilities are composed from these four, not added as new tools.
- Use cron isolation for heavy tasks to keep the interactive loop lean and within token budgets.
- Daily learned flush provides auditability and makes compaction safer because the raw learned entries are always preserved in R2.
- Delete legacy code. Do not keep compatibility shims unless required for a time-bounded migration window (document the window and removal date if so).
- The DO keying strategy must be deterministic and documented. Thread-level isolation is the default; channel-level state is a fallback for non-threaded messages.

-----

## 7. Technical Considerations

- Vectorize metadata limits (roughly 1KB) require R2 as the full content store. Never store full memory content in Vectorize metadata.
- Idempotency keys are required for: PR creation (based on branch name + commit hash), merge operations (based on PR number + merge SHA), deploy triggers (based on merge SHA), and cron runs (based on job_name + scheduled_time).
- Daily learned flush format is JSONL: machine-parseable, append-friendly, consistent with log.jsonl.
- Cloudflare Sandbox resource limits: document the current limits (CPU, memory, disk, network) and design tool safety limits to stay within them.
- GitHub API rate limits: the system must respect rate limits and implement backoff. For authenticated requests, the limit is 5,000/hour; the system should track remaining quota and warn when below 10%.
- R2 consistency: R2 is eventually consistent for overwrites. The system must use versioned keys or conditional writes where ordering matters (e.g., compaction replacing items).

-----

## 8. Success Metrics

1. **End-to-end PR flow**: Slack request → PR created → Slack summary in under 5 minutes for a single-file change.
1. **Merge/deploy**: when enabled, merge triggers deploy and Slack receives deploy status within the configured timeout.
1. **Cron isolation**: scanning runs via cron without inflating interactive context. Interactive response latency is not degraded during cron execution.
1. **Alerts**: cron failures generate Slack alerts within one heartbeat cycle (≤10 minutes) of detection threshold being crossed.
1. **Memory**: daily learned file is written before every compaction. Compaction reduces total memory item count by ≥20% per run when items exceed retention thresholds.
1. **Cost**: daily token usage stays within the configured ceiling. No runaway loops that burn budget.
1. **Legacy removal**: zero dead code paths. A fresh developer can trace from Slack ingest to PR creation by reading one documented happy path.

-----

## 9. Decisions Made (from Open Questions)

1. **Daily learned flush format**: JSONL. It’s machine-parseable, append-friendly, and consistent with the existing log.jsonl convention.
1. **Always upload daily learned entries to R2**: Yes. Workspace persistence on Cloudflare Sandbox is not guaranteed. Losing a daily file before upload means permanent loss of learned context. Upload cost is negligible.
1. **Scanning job configuration**: Defined in `config/scan-targets.json` in R2. Schema: `{ sources: [{ name, type, url, cadence_override?, params? }] }`. Add or remove scan targets without code changes.
1. **Alert thresholds**: N=3 consecutive failures (`CRON_FAIL_THRESHOLD`), stall window = 2× expected cadence (`CRON_STALL_MULTIPLIER`). Both configurable via environment variables.

-----

## 10. Remaining Open Questions

1. Sandbox resource limits — what are the current CPU/memory/disk/network caps, and do they constrain any of the planned workflows (e.g., large repo clones)?
1. Thread-to-channel state migration — copy-on-first-thread-message or lazy lookup? Each has tradeoffs for latency vs. consistency.
1. Deploy hook mechanism preference — webhook, GitHub Actions dispatch, or Cloudflare Pages hook? This may vary per repo.
1. Whether to implement a separate “reserve budget” for critical jobs (deploy-status checks) or simply exempt them from the daily ceiling.