# PRD: Blob Hardening — Security, Reliability & Architecture

## 1. Introduction / Overview

Blob is a Slack-driven autonomous assistant built on Cloudflare Workers, Durable Objects, Cloudflare Sandbox, and R2. A comprehensive code review identified 24 issues across security, reliability, architecture, and operational safety. This PRD defines the work required to address all of them.

The issues fall into five categories:

- **Architecture & Structure** (items 1–3): god-object DO, duplicate memory systems, no command routing
- **Security** (items 4–8): secret exposure, credential leakage, missing auth, weak command filtering, incomplete diff scanning
- **Reliability & Error Handling** (items 9–14): dead code, inconsistent token estimation, silent failures, missing retries, legacy parsing
- **Operational** (items 15–21): no degradation, no backoff, unbounded fetches, no rate limiting, volatile token tracking, missing security tests
- **Self-Building Safety** (items 22–24): no deploy approval gate, no rollback, unsandboxed self-created tools

This is not a feature project. It is a hardening pass. The goal is to make Blob safe enough to recommend to someone other than its author.

## 2. Goals

1. **Eliminate plaintext secret exposure.** No stored secret should be readable by the agent in raw form. The `/secrets/values` endpoint must be removed. Secrets must be injected through a controlled proxy, not written to disk as a sourceable file.
1. **Unify the memory system.** The codebase must have exactly one memory subsystem with one R2 key schema, one token estimator, and one interface for embeddings/recall.
1. **Decompose the Durable Object.** `do.ts` must be split into a thin router that delegates to focused handler modules. No single file should exceed ~200 lines of business logic.
1. **Add a deploy approval gate.** The agent must not be able to deploy code changes without explicit human approval via Slack. A diff must be posted and a confirmation must be received before any merge or deploy trigger fires.
1. **Silence zero silent failures.** Every `catch {}` block must either log or propagate. No swallowed errors.
1. **Add security tests.** Every security-critical function (`redactSecrets`, `allowedCommand`, `scanDiffForSecrets`, `normalizeToolPath`, secret storage lifecycle) must have test coverage including adversarial edge cases.
1. **Add operational resilience.** Rate limiting on Slack inbound, circuit breakers for external services, backoff on heartbeat failure, bounded fetches in cron jobs.

## 3. User Stories

- **As the operator**, I want secrets to be inaccessible to the agent in plaintext so that a compromised agent cannot exfiltrate credentials.
- **As the operator**, I want to approve deploys before they execute so that the agent cannot ship a broken or malicious version of itself without my review.
- **As a developer reading the code**, I want a single memory system with consistent interfaces so that I can understand how Blob stores and retrieves knowledge.
- **As the operator**, I want Blob to degrade gracefully when R2, Vectorize, or the Sandbox is unavailable so that a single service outage does not crash the entire system.
- **As the operator**, I want Slack inbound to be rate-limited so that a message flood cannot exhaust my LLM budget or Cloudflare compute.
- **As a contributor**, I want the DO to be decomposed into small, testable modules so that I can modify one subsystem without reading 639 lines of URL routing.
- **As the operator**, I want self-created tools (`.blob/tools/`) to be validated and expire so that a bad tool created by the agent does not persist and execute forever.

## 4. Functional Requirements

### Architecture & Structure

- FR-1: The system must replace `do.ts` with a thin router that delegates to handler modules (jobs, messages, settings, cron, secrets, memory, heartbeat). Each handler module must be in its own file under `src/agent/handlers/`.
- FR-2: The system must delete one of the two memory systems (`memory.ts` or `memory-system.ts`) and migrate all callers to the surviving one. The surviving system must use a single R2 key schema and a single token estimator.
- FR-3: The system must extract a command registry from `slack.ts` so that command matching, intent classification, and message handling are in separate modules. `slack.ts` must not exceed ~200 lines after extraction.

### Security

- FR-4: The system must remove the `/secrets/values` endpoint from the DO. Secrets must be accessible only through a proxy mechanism that injects them into sandbox environment variables without exposing raw values to the agent’s conversation context or tool output.
- FR-5: The system must stop writing secrets to `.blob/config/.env` as a sourceable file. Instead, secrets must be injected as environment variables when the sandbox session starts, scoped to only the secrets the current task requires.
- FR-6: The system must stop interpolating `GITHUB_TOKEN` into git remote URLs. Instead, it must use a git credential helper script that reads the token from an environment variable at authentication time without embedding it in the URL.
- FR-7: The system must add authentication to the DO’s internal API. Requests must include a shared secret (derived from a Wrangler secret) and the DO must reject requests without it.
- FR-8: The system must replace the `allowedCommand` regex blocklist with either (a) a documented acknowledgment that the Cloudflare Sandbox is the security boundary and removal of the function, or (b) a proper allowlist approach. The current four-regex blocklist must be removed regardless.
- FR-9: The system must update `scanDiffForSecrets` to scan both `+` and context lines (lines without `+` or `-` prefix) so that reformatted secrets are detected.

### Reliability & Error Handling

- FR-10: The system must fix the dead branch in `do.ts` message compaction where the `> 100` check is unreachable because `> 25` matches first.
- FR-11: The system must use a single `estimateTokens` function across the entire codebase. The function must live in a shared utility module.
- FR-12: The system must replace all silent `catch {}` blocks with `catch` blocks that log via `logEvent`. A grep for `catch {` or `catch (_)` followed by empty/comment-only bodies must return zero results.
- FR-13: The system must add retry logic (with exponential backoff, max 3 attempts) to the `callLLM` function in `pi-agent.ts` for transient HTTP errors (429, 500, 502, 503, 504).
- FR-14: The system must remove the regex-based `parseToolCall` function and the `TOOL: <n>\nARG: <json>` instruction from the system prompt. All tool calling must use structured tool calls via the API’s `tools` parameter exclusively.

### Operational

- FR-15: The system must add a health check endpoint (`GET /health`) that reports the status of R2, Vectorize, Sandbox, and the DO. When any dependency is unavailable, affected operations must degrade gracefully (e.g., skip vectorize upsert, skip R2 persistence) rather than throwing.
- FR-16: The system must add exponential backoff to the heartbeat alarm. After N consecutive heartbeat failures (configurable, default 3), the interval must double, up to a maximum of 1 hour. On success, the interval must reset to the configured default.
- FR-17: The system must add a timeout (configurable, default 10s) and max response size (configurable, default 1MB) to the `fetch` call in `runContentScan`.
- FR-18: The system must add per-channel rate limiting to the Slack inbound path. After N messages (configurable, default 20) within a sliding window (configurable, default 60s), additional messages must be queued or dropped with a Slack reply indicating rate limiting.
- FR-19: The system must move daily token tracking from the module-level `Map` to DO storage as the primary path. The in-memory `Map` must be removed. If the DO is unreachable, token tracking must fail-closed (reject the request) rather than fail-open.
- FR-20: The system must add tests for: `redactSecrets` (with URL-encoded tokens, multi-line inputs, edge cases), `normalizeToolPath` (with `..`, absolute paths, symlink-like inputs), `scanDiffForSecrets` (reformatted lines, partial matches), and the secret storage/retrieval lifecycle.

### Self-Building Safety

- FR-21: The system must add a deploy approval gate. When the agent wants to deploy, it must: (a) post the full diff to a Slack channel, (b) wait for an explicit approval message (e.g., “approve” or a reaction) from an authorized user, (c) only then trigger the deploy. Deploys without approval must be blocked.
- FR-22: The system must add a rollback mechanism. After a deploy, the system must monitor the next N heartbeats (configurable, default 3). If all N fail, the system must automatically revert to the previous Wrangler deployment version and post an alert to Slack.
- FR-23: The system must add validation and expiration to self-created tools in `.blob/tools/`. Tools must: (a) be recorded in the manifest with a creation timestamp and last-used timestamp, (b) expire after N days of non-use (configurable, default 30), (c) be scanned for secret patterns before promotion from `.blob/scratch/` to `.blob/tools/`.

## 5. Non-Goals (Out of Scope)

- Multi-channel support (Telegram, Discord, etc.). Blob remains Slack-only.
- Container-level isolation (like NanoClaw). Blob relies on Cloudflare Sandbox for execution isolation.
- User-facing UI or dashboard. All interaction remains through Slack.
- Changing the 4-tool philosophy (read, write, edit, bash). The tool set stays the same.
- Migration away from Cloudflare. The Worker/DO/R2/Sandbox architecture is retained.

## 6. Design Considerations

### DO Decomposition Pattern

The DO router should use a simple pattern:

```
fetch(request) → parse URL → delegate to handler module → return response
```

Each handler module exports functions that accept `(state, storage, env, request)` and return `Response`. The DO class holds state and passes it down. This avoids framework dependencies while achieving separation.

### Secret Injection Model

Secrets should flow: `DO storage → Worker → sandbox env vars (at session start)`. The agent never sees the raw values in its conversation. The system prompt instructs the agent to use environment variables, not files. The `.blob/config/.env` file approach is eliminated entirely.

### Deploy Approval Flow

```
Agent pushes branch → Agent posts diff to Slack → Operator reviews →
Operator sends "approve" → Worker receives approval →
Worker triggers deploy → Worker monitors health → (rollback if unhealthy)
```

The approval state should be stored in the DO with a TTL (e.g., 30 minutes). Stale approvals expire automatically.

### Memory System Consolidation

Keep `memory-system.ts` (the more complete implementation with R2MemoryStore, validation, compaction, reconciliation, retention, and learned entries). Refactor `memory.ts` callers (pi-agent, slack) to use the `memory-system.ts` interfaces. Delete `memory.ts`.

## 7. Technical Considerations

- **DO state migration**: The DO already has `state/migrate` logic. Schema changes to `BlobState` must be backward-compatible. Add a version field to the stored state and migrate on init.
- **Wrangler rollback**: Cloudflare Workers support `wrangler rollback` which reverts to the previous deployment. The rollback mechanism should shell out to this or use the Cloudflare API directly.
- **Rate limiting in Workers**: Use the DO’s single-threaded execution model to implement rate limiting. Store a sliding window of timestamps per channel in DO storage (not SQL — too expensive for per-message writes). Use the DO’s in-memory state with periodic persistence.
- **Testing**: All new modules must have corresponding test files. Tests should use the existing Vitest setup. Mock Cloudflare bindings (R2, DO, Vectorize, Sandbox) using the patterns already established in the test suite.

## 8. Success Metrics

- `grep -r "catch {" src/ | wc -l` returns 0 (no silent catch blocks).
- `grep -r "/secrets/values" src/ | wc -l` returns 0 (no plaintext secret endpoint).
- `grep -r "parseToolCall" src/ | wc -l` returns 0 (legacy regex parser removed).
- `do.ts` is under 100 lines (router only, no business logic).
- `slack.ts` is under 200 lines.
- Only one file imports from `@cf/baai/bge-small-en-v1.5` (single memory system).
- All 7 security test files pass with adversarial inputs.
- Deploy cannot proceed without Slack approval (verified by test).
- Heartbeat backs off after 3 consecutive failures (verified by test).
- Daily token ceiling is enforced even after Worker cold start (verified by test).

## 9. Resolved Decisions

1. **Secret injection scope**: All stored secrets are injected into every sandbox session. Per-task scoping is deferred to a future iteration.
1. **Deploy approval authorization**: Configurable allowlist of Slack user IDs. Stored in R2 at `config/deploy-approvers.json`.
1. **`allowedCommand` disposition**: Remove entirely. Document that the Cloudflare Sandbox (Firecracker microVM) is the security boundary. No application-level command filtering.
1. **Self-created tool expiration**: 30 days of non-use, configurable via `TOOL_EXPIRY_DAYS` env var.
1. **Memory consolidation**: Keep `memory-system.ts` as the sole memory system. Migrate all `memory.ts` callers to `memory-system.ts` interfaces. Delete `memory.ts`.