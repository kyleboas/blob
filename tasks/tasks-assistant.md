# Tasks: Blob Hardening — Security, Reliability & Architecture

## Relevant Files

### Existing files to modify

- `src/agent/do.ts` - God-object DO. Decompose into router + handler modules. Currently 639 lines.
- `src/agent/pi-agent.ts` - Agent loop. Remove regex tool parsing, fix secret injection, add LLM retry. Currently 852 lines.
- `src/agent/deploy.ts` - Deploy pipeline. Add approval gate and rollback mechanism.
- `src/agent/capabilities.ts` - Minimal capabilities module (4 lines). May be folded into another module.
- `src/core/memory.ts` - Memory system #1. DELETE this file after migrating callers.
- `src/core/memory-system.ts` - Memory system #2. Becomes the sole memory system. Add shared token estimator.
- `src/core/safety.ts` - Secret redaction. Harden patterns, remove `allowedCommand` callers.
- `src/core/llm.ts` - LLM routing. Adopt shared token estimator.
- `src/core/observability.ts` - Logging. No structural changes, but all silent catches must route here.
- `src/core/types.ts` - Env type definitions. Add new env vars (TOOL_EXPIRY_DAYS, RATE_LIMIT_*, DO_AUTH_SECRET, etc.).
- `src/integrations/slack.ts` - Slack handler. Decompose into command registry + rate limiting. Currently 603 lines.
- `src/integrations/slack-routing.ts` - Slack signature verification. Minor changes for rate limiting.
- `src/integrations/sandbox.ts` - Sandbox execution. Remove `allowedCommand`, change secret injection.
- `src/integrations/github.ts` - GitHub API. Fix `scanDiffForSecrets` to cover context lines.
- `src/jobs/cron-jobs.ts` - Cron dispatch. Bound `fetch` in content-scan.
- `src/jobs/job-model.ts` - Job state machine. No changes expected.
- `src/index.ts` - Worker entry point. Add `/health` endpoint.
- `wrangler.agent.toml` - Add new secrets and env var declarations.

### New files to create

- `src/agent/handlers/jobs.ts` - Job CRUD handler extracted from DO.
- `src/agent/handlers/messages.ts` - Message storage handler extracted from DO.
- `src/agent/handlers/settings.ts` - Settings (verbosity, heartbeat config) handler extracted from DO.
- `src/agent/handlers/cron.ts` - Cron CRUD and outcomes handler extracted from DO.
- `src/agent/handlers/secrets.ts` - Secret storage handler (write-only, no plaintext read endpoint).
- `src/agent/handlers/memory-status.ts` - Learned memory and vectorize status handler.
- `src/agent/handlers/heartbeat.ts` - Heartbeat status handler.
- `src/agent/do-router.ts` - Thin URL router that delegates to handler modules.
- `src/integrations/slack-commands.ts` - Command registry extracted from slack.ts.
- `src/integrations/slack-rate-limit.ts` - Per-channel rate limiting for Slack inbound.
- `src/core/tokens.ts` - Shared `estimateTokens` utility used by all modules.
- `src/agent/deploy-approval.ts` - Deploy approval gate (Slack-based approval flow).
- `src/agent/deploy-rollback.ts` - Post-deploy health monitoring and rollback.
- `src/agent/tool-lifecycle.ts` - Self-created tool validation, expiration, and manifest management.
- `src/tests/secret-security.test.ts` - Tests for redactSecrets, secret lifecycle, URL-encoded tokens.
- `src/tests/path-security.test.ts` - Tests for normalizeToolPath with adversarial inputs.
- `src/tests/diff-scanning.test.ts` - Tests for scanDiffForSecrets with reformatted lines.
- `src/tests/deploy-approval.test.ts` - Tests for approval gate flow.
- `src/tests/deploy-rollback.test.ts` - Tests for rollback mechanism.
- `src/tests/rate-limit.test.ts` - Tests for Slack rate limiting.
- `src/tests/heartbeat-backoff.test.ts` - Tests for heartbeat exponential backoff.
- `src/tests/tool-lifecycle.test.ts` - Tests for tool validation and expiration.
- `src/tests/memory-consolidated.test.ts` - Tests for the consolidated memory system.
- `src/tests/do-router.test.ts` - Tests for the decomposed DO router.
- `src/tests/silent-catch-audit.test.ts` - Meta-test that greps for silent catch blocks and fails if any exist.

### Notes

- Unit tests are placed in `src/tests/` following the existing project convention.
- Use `npm test` to run the full Vitest suite.
- Use `npm run typecheck` to verify TypeScript compilation.
- Each task should pass both `npm run typecheck` and `npm test` before being marked complete.
- The PRD is at `tasks/prd-blob-hardening.md`.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don’t skip any steps.

Example:

- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch: `git checkout -b feature/blob-hardening`

-----

- [ ] 1.0 Decompose the Durable Object and Slack handler (FR-1, FR-3)
  - [x] 1.1 Create `src/core/tokens.ts` with a single `estimateTokens(text: string): number` function. Use the word-count-based estimator from `memory-system.ts` (`Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3)`). Export it as the sole token estimator for the project.
  - [ ] 1.2 Create `src/agent/do-router.ts`. Implement a `routeRequest(url: URL, method: string, request: Request, ctx: { state: DurableObjectState; env: Env; data: BlobState; save: () => Promise<void> })` function that maps URL+method pairs to handler functions. Return 404 for unmatched routes.
  - [x] 1.3 Create `src/agent/handlers/jobs.ts`. Extract the `/jobs` POST, `/jobs` GET, and `/jobs/transition` POST logic from `do.ts` into exported handler functions. Each function accepts the router context and returns `Response`.
  - [x] 1.4 Create `src/agent/handlers/messages.ts`. Extract `/messages` GET and POST. Fix the dead branch: the `> 25` compaction and `> 100` trim must be evaluated correctly (check `> 100` first, then `> 25`).
  - [x] 1.5 Create `src/agent/handlers/settings.ts`. Extract `/settings/verbosity` and `/settings/heartbeat` GET/POST.
  - [x] 1.6 Create `src/agent/handlers/cron.ts`. Extract `/cron` GET/POST, `/cron/delete` POST, `/cron/outcome` POST, `/cron/outcomes` GET.
  - [x] 1.7 Create `src/agent/handlers/secrets.ts`. Extract `/secrets` GET and POST. Do NOT extract `/secrets/values` — it will be removed in task 3. Do NOT extract `/secrets/delete` yet — move it here but keep it.
  - [x] 1.8 Create `src/agent/handlers/memory-status.ts`. Extract `/memory/learned/status` and `/memory/vectorize/status` GET/POST.
  - [x] 1.9 Create `src/agent/handlers/heartbeat.ts`. Extract `/heartbeat/status` GET. Extract `/daily-tokens` GET/POST. Extract `/events/check` POST.
  - [x] 1.10 Rewrite `do.ts` to be a thin class: constructor, `init()`, `alarm()`, `fetch()` (which calls `routeRequest`), and `save()`. All business logic lives in handler modules. Target: under 100 lines.
  - [ ] 1.11 Create `src/integrations/slack-commands.ts`. Extract from `slack.ts`: `getExactKeywordCommand`, `classifyIntent`, `detectAndStoreSecret`, `mightBeHeartbeatConfig`, `parseHeartbeatConfig`, `formatHeartbeatInterval`, `TOKEN_PATTERNS`, and all command-handling branches (status, settings, selftest, secrets, heartbeat config, set minimal/verbose, delete secret). Export a `handleCommand(text: string, channel: string, env: Env, conversationDO: DurableObjectStub | null): Promise<{ handled: boolean; response?: string }>` function.
  - [ ] 1.12 Refactor `slack.ts` to import from `slack-commands.ts`. The main `processSlackMessage` function should: verify signature → check dedup → call `handleCommand` → if not handled, run intent classification → dispatch to agent or LLM. Target: under 200 lines.
  - [ ] 1.13 Create `src/tests/do-router.test.ts`. Test that each URL+method routes to the correct handler and that unknown routes return 404.
  - [ ] 1.14 Run `npm run typecheck && npm test`. Fix any failures.

-----

- [ ] 2.0 Consolidate memory systems and shared utilities (FR-2, FR-11)
  - [ ] 2.1 Audit all imports of `src/core/memory.ts`. List every function imported and by which files: `pi-agent.ts`, `slack.ts`, `cron-jobs.ts`, and any others.
  - [ ] 2.2 For each function in `memory.ts`, identify the equivalent in `memory-system.ts` or create a thin wrapper in `memory-system.ts` that provides the same interface. Key mappings: `appendLearnedRecord` → use `writeMemoryItem` or a new `appendLearned` wrapper. `flushLearnedRecordsToR2` → use `appendDailyLearned` + R2 put. `querySemanticMemory` → use `queryVectors` + `R2MemoryStore.read`. `buildSemanticMemoryContext` → use `buildRetrievedMemoryBlock` or adapt. `upsertSemanticMemory` → use `upsertVector`. Status update functions → keep as thin DO fetch wrappers in a separate `memory-status.ts` (already extracted in task 1.8).
  - [ ] 2.3 Update `pi-agent.ts` to import from `memory-system.ts` instead of `memory.ts`. Replace all `memory.ts` function calls with `memory-system.ts` equivalents. Verify the R2 key schema is consistent (use `memory-system.ts`’s `mem/{id}.json` pattern everywhere).
  - [ ] 2.4 Update `slack.ts` to import `getLearnedMemoryStatus` and `getVectorizeMemoryStatus` from the handler module or from `memory-system.ts`.
  - [ ] 2.5 Update `cron-jobs.ts` — it already uses `memory-system.ts`, so verify no `memory.ts` imports remain.
  - [ ] 2.6 Replace all occurrences of `Math.ceil(text.length / 4)` (the char-based estimator in `pi-agent.ts`) with `estimateTokens` from `src/core/tokens.ts`. Replace all occurrences of the word-count estimator in `memory-system.ts` with the same import.
  - [ ] 2.7 Delete `src/core/memory.ts`.
  - [ ] 2.8 Create `src/tests/memory-consolidated.test.ts`. Test: write a memory item, recall it by semantic query, compact a scope, verify retention policy, verify duplicate detection.
  - [ ] 2.9 Run `npm run typecheck && npm test`. Verify `grep -r "from.*memory\.ts\|from.*\/memory\"" src/ --include="*.ts" | grep -v memory-system | grep -v test` returns nothing.

-----

- [ ] 3.0 Harden security: secrets, auth, command filtering, diff scanning (FR-4, FR-5, FR-6, FR-7, FR-8, FR-9)
  - [ ] 3.1 Remove the `/secrets/values` GET endpoint from `src/agent/handlers/secrets.ts`. The `/secrets` GET (which returns only names, not values) stays. The `/secrets` POST (write) stays. The `/secrets/delete` POST stays.
  - [ ] 3.2 Create a new internal-only method in `secrets.ts` handler: `getSecretsForInjection(storage): Record<string, string>` that reads secret values from DO SQL storage. This is callable only by the DO itself (alarm, internal methods), never exposed as an HTTP endpoint.
  - [ ] 3.3 Refactor `pi-agent.ts` `ensureToolFramework()`: remove the block that fetches `/secrets/values` and writes `.blob/config/.env`. Instead, the agent’s `run()` method should receive a `secrets: Record<string, string>` parameter that the calling code (slack.ts) obtains from the DO internally. Secrets are passed as environment variables to `executeInSandbox` calls, not written to files.
  - [ ] 3.4 Update `sandbox.ts` `executeInSandbox` to accept an optional `envVars: Record<string, string>` parameter. When present, prepend `export KEY=VALUE;` for each entry before the command. (The Cloudflare Sandbox exec likely supports env injection natively — check the API. If so, use that instead of shell export.)
  - [ ] 3.5 Remove `fetchStoredSecrets()` method from `pi-agent.ts` entirely.
  - [ ] 3.6 Refactor `ensureRepoBootstrapped` in `pi-agent.ts`: replace the inline `GITHUB_TOKEN` URL interpolation with a git credential helper approach. Create a small script that reads `$GITHUB_TOKEN` from the environment and outputs it in git-credential format. Write this script to the sandbox at bootstrap time (not the token itself — only the helper script). Set `GIT_ASKPASS` to point to it.
  - [ ] 3.7 Add DO internal API authentication. Add a `DO_AUTH_SECRET` Wrangler secret. In `do-router.ts`, check for an `x-do-auth` header on every request and reject with 403 if it doesn’t match. Update all DO callers (slack.ts, cron-jobs.ts, pi-agent.ts, memory functions) to include this header when calling `do_.fetch(...)`.
  - [ ] 3.8 Remove the `allowedCommand` function from `sandbox.ts`. Remove the call to it in `executeInSandbox`. Add a code comment: `// Security boundary: Cloudflare Sandbox (Firecracker microVM) provides execution isolation. No application-level command filtering.`
  - [ ] 3.9 Update `scanDiffForSecrets` in `github.ts`: change the line filter from `line.startsWith("+")` to include context lines as well. Filter out only lines starting with `-` (removed lines). This catches reformatted secrets that appear as context or added lines.
  - [ ] 3.10 Update `redactSecrets` in `safety.ts`: add a pattern for URL-encoded tokens (e.g., `https://x-access-token:[^@]+@`). Add a pattern for base64-encoded strings longer than 40 chars that appear in auth-like contexts.
  - [ ] 3.11 Add `DO_AUTH_SECRET` to `src/core/types.ts` Env interface. Add `TOOL_EXPIRY_DAYS` to Env interface.
  - [ ] 3.12 Run `npm run typecheck && npm test`. Verify `grep -r "secrets/values" src/ --include="*.ts"` returns nothing. Verify `grep -r "allowedCommand" src/ --include="*.ts"` returns nothing.

-----

- [ ] 4.0 Fix reliability: dead code, silent failures, retries, legacy parsing (FR-10, FR-12, FR-13, FR-14)
  - [ ] 4.1 Fix message compaction in `src/agent/handlers/messages.ts` (already extracted in 1.4, but verify): check `> 100` first (hard trim), then `> 25` (compact). The logic should be: `if (messages.length > 100) { trim to last 100 } else if (messages.length > 25) { compact }`.
  - [ ] 4.2 Audit every `catch` block in the codebase. Run `grep -n "catch" src/**/*.ts --include="*.ts" -r` and list each one. For each block that has an empty body, a comment-only body, or `// fall through` / `// silently fail` / `// best effort`: add a `logEvent(env, category, event, { error: String(err) })` call. Use the closest available `env` — if none available, use `console.error` as last resort.
  - [ ] 4.3 Create `src/tests/silent-catch-audit.test.ts`. This test reads all `.ts` files in `src/` (excluding tests), parses for `catch` blocks, and fails if any catch block body is empty or contains only comments. This prevents future regressions.
  - [ ] 4.4 Add retry logic to `callLLM` in `pi-agent.ts`. Wrap the fetch call in a retry loop: max 3 attempts, exponential backoff (1s, 2s, 4s), retry on status 429/500/502/503/504 or network errors. Log each retry via `logEvent`.
  - [ ] 4.5 Remove the `parseToolCall` function from `pi-agent.ts`. Remove the regex-based `TOOL: <n>\nARG: <json>` instruction from `buildSystemPrompt()`. Remove the fallback line `const toolCall = structuredToolCall ?? parseToolCall(responseText)` — use only `structuredToolCall`. If `structuredToolCall` is null, the model thinks it’s done (existing behavior for no tool call).
  - [ ] 4.6 Remove `parseToolCall` from the `__piAgentTestUtils` export. Update any tests that reference it.
  - [ ] 4.7 Update the system prompt in `buildSystemPrompt()` to remove all references to `TOOL:` and `ARG:` text format. The model should rely entirely on the structured `tools` parameter.
  - [ ] 4.8 Run `npm run typecheck && npm test`. Verify `grep -r "parseToolCall" src/ --include="*.ts"` returns nothing (except possibly the test utils cleanup). Verify `grep -rn "catch\s*{" src/ --include="*.ts" | grep -v test` returns nothing.

-----

- [ ] 5.0 Add operational resilience: health checks, backoff, rate limiting, bounded fetches, durable token tracking (FR-15, FR-16, FR-17, FR-18, FR-19)
  - [ ] 5.1 Add a `GET /health` endpoint to `src/index.ts`. It should check: (a) R2 — attempt a `head` on a known key, (b) Sandbox — call `start()` if available, (c) DO — fetch `/heartbeat/status`. Return `{ status: "healthy" | "degraded" | "unhealthy", checks: { r2: bool, sandbox: bool, do: bool } }`. Each check has a 5s timeout.
  - [ ] 5.2 Add graceful degradation to `pi-agent.ts`. Wrap `querySemanticMemory` at the start of `run()` in a try-catch that logs and continues with empty matches (already partially done, but verify). Wrap `persistLearnedMemory` in `finishRun` to log and continue on failure (already partially done, but ensure `logEvent` is called, not silent).
  - [ ] 5.3 Add heartbeat backoff to `alarm()` in the DO. Track `consecutiveHeartbeatFailures` in `BlobState`. On heartbeat error, increment the counter. If counter >= 3 (configurable via `HEARTBEAT_BACKOFF_THRESHOLD`), double the alarm interval up to max 1 hour. On success, reset counter and interval to default.
  - [ ] 5.4 Update `runContentScan` in `cron-jobs.ts`. Replace `await fetch(source.url)` with a bounded fetch: add `AbortSignal.timeout(10000)` (10s, configurable via `CONTENT_SCAN_TIMEOUT_MS`) and limit response body to 1MB by reading only the first 1MB of the response stream.
  - [ ] 5.5 Create `src/integrations/slack-rate-limit.ts`. Implement a sliding-window rate limiter: `checkRateLimit(channelId: string, now: number): { allowed: boolean; retryAfterMs?: number }`. Store timestamps in a module-level `Map<string, number[]>`. Configurable window (default 60s) and max messages (default 20) via env vars `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX_MESSAGES`.
  - [ ] 5.6 Integrate rate limiting into `slack.ts`. After signature verification and before intent classification, call `checkRateLimit`. If not allowed, reply with a short rate-limit message to Slack and return early.
  - [ ] 5.7 Remove `dailyTokenUsageLocal` (the module-level `Map`) from `pi-agent.ts`. Update `consumeDailyBudget` to use the DO as the only path. If the DO is unreachable, fail-closed: return `false` (reject the request). Log the failure.
  - [ ] 5.8 Add `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_MESSAGES`, `HEARTBEAT_BACKOFF_THRESHOLD`, `CONTENT_SCAN_TIMEOUT_MS` to `src/core/types.ts` Env interface.
  - [ ] 5.9 Create `src/tests/rate-limit.test.ts`. Test: allow messages up to limit, block message at limit+1, allow after window expires.
  - [ ] 5.10 Create `src/tests/heartbeat-backoff.test.ts`. Test: 3 failures double interval, success resets, max interval is capped at 1 hour.
  - [ ] 5.11 Run `npm run typecheck && npm test`. Verify `grep -r "dailyTokenUsageLocal" src/ --include="*.ts"` returns nothing.

-----

- [ ] 6.0 Add self-building safety: deploy approval gate, rollback, tool validation (FR-21, FR-22, FR-23)
  - [ ] 6.1 Create `src/agent/deploy-approval.ts`. Implement the approval flow: `requestApproval(diff: string, channel: string, env: Env): Promise<string>` posts the diff (or a truncated summary + link) to Slack and returns an approval request ID. `checkApproval(requestId: string, env: Env): Promise<"pending" | "approved" | "rejected" | "expired">` checks DO state for approval. `processApprovalMessage(text: string, userId: string, env: Env): Promise<boolean>` checks if the message is an approval from an authorized user (checks `config/deploy-approvers.json` in R2 for the allowlist).
  - [ ] 6.2 Add DO state for pending approvals. In `BlobState`, add `pendingDeploy?: { requestId: string; diff: string; requestedAt: number; approvedBy?: string; status: "pending" | "approved" | "rejected" | "expired" }`. Add a `/deploy/approval` POST endpoint (in a new handler) to update approval status. Add TTL logic: approvals expire after 30 minutes.
  - [ ] 6.3 Update `deploy.ts` `triggerDeploy`: before triggering, call `checkApproval`. If not approved, return `{ status: "skipped", details: "Awaiting approval" }`. Only proceed if approved.
  - [ ] 6.4 Wire approval into the Slack flow. When the agent’s response includes a deploy intent (detected by a new keyword check or explicit tool call), call `requestApproval` instead of `triggerDeploy`. When a Slack message matches “approve” or “reject” in the deploy channel, call `processApprovalMessage`.
  - [ ] 6.5 Create `src/agent/deploy-rollback.ts`. Implement: `monitorPostDeploy(env: Env, heartbeatCount: number): Promise<"healthy" | "unhealthy">` watches N heartbeats after deploy. If all N fail, call `rollback(env: Env): Promise<void>` which uses the Cloudflare API (`PUT /accounts/{id}/workers/scripts/{name}/rollback`) to revert to the previous version and posts an alert to Slack.
  - [ ] 6.6 Wire rollback into the heartbeat alarm. After a deploy (tracked via a `lastDeployAt` timestamp in BlobState), the alarm checks if we’re in the post-deploy monitoring window. If consecutive failures exceed the threshold during this window, trigger rollback.
  - [ ] 6.7 Create `src/agent/tool-lifecycle.ts`. Implement: `validateTool(manifestPath: string, toolPath: string, env: Env): Promise<{ valid: boolean; reason?: string }>` scans tool script content for secret patterns (using `getSecretPatterns`). `expireUnusedTools(manifestPath: string, env: Env, maxAgeDays: number): Promise<string[]>` reads the manifest, finds tools with `lastUsedAt` older than `maxAgeDays` days, deletes them from the sandbox, and removes them from the manifest. Returns list of expired tool names.
  - [ ] 6.8 Update `ensureToolFramework` in `pi-agent.ts` to call `expireUnusedTools` during bootstrap. Read `TOOL_EXPIRY_DAYS` from env (default 30).
  - [ ] 6.9 Update the system prompt’s Self-Tool-Creation Framework section: add instruction that tools are validated for secrets before promotion, and that unused tools expire after the configured period.
  - [ ] 6.10 Create `config/deploy-approvers.json` with structure `{ "allowedUserIds": [] }`. Add to R2 via setup docs.
  - [ ] 6.11 Create `src/tests/deploy-approval.test.ts`. Test: request posts to Slack, unauthorized user cannot approve, authorized user approves, expired approval is rejected, deploy proceeds only after approval.
  - [ ] 6.12 Create `src/tests/deploy-rollback.test.ts`. Test: healthy heartbeats after deploy do nothing, N consecutive failures trigger rollback API call, alert is posted to Slack.
  - [ ] 6.13 Create `src/tests/tool-lifecycle.test.ts`. Test: tool with secret pattern is rejected, tool unused for 31 days is expired, tool used yesterday is kept, manifest is updated correctly.
  - [ ] 6.14 Run `npm run typecheck && npm test`.

-----

- [ ] 7.0 Add security and integration tests (FR-20, plus coverage for tasks 3–6)
  - [ ] 7.1 Create `src/tests/secret-security.test.ts`. Test `redactSecrets` with: plain API key, URL-encoded token in git URL (`https://x-access-token:ghp_xxxx@github.com/`), base64-encoded bearer token, multi-line input with secrets on different lines, private key block, token split across a line break (should not match — verify expected behavior), empty input, input with no secrets (should return unchanged).
  - [ ] 7.2 Create `src/tests/path-security.test.ts`. Test `normalizeToolPath` with: `../../../etc/passwd`, absolute path `/etc/passwd`, `./valid/path`, path starting with workspace prefix (should strip), empty string (should throw), path with embedded `..` (`foo/../../bar`), path with URL encoding (`%2e%2e` — verify it doesn’t bypass).
  - [ ] 7.3 Create `src/tests/diff-scanning.test.ts`. Test `scanDiffForSecrets` with: added line with API key (should block), removed line with API key (should NOT block — it’s being removed), context line with API key (should block after FR-9 fix), reformatted line where only whitespace changed but token is present (should block), clean diff (should pass), diff with partial pattern match across lines (verify behavior).
  - [ ] 7.4 Verify that the DO `/secrets/values` endpoint no longer exists. Write a test in `src/tests/secret-security.test.ts` that constructs a request to the DO router for `GET /secrets/values` and asserts it returns 404.
  - [ ] 7.5 Verify that no `.ts` file in `src/` (excluding tests) contains `catch {` or `catch (_)` followed by an empty/comment-only body. This should already be covered by `silent-catch-audit.test.ts` from task 4.3 — run it and confirm zero failures.
  - [ ] 7.6 Run the full test suite: `npm run typecheck && npm test`. All tests must pass. Document any known flaky tests.
  - [ ] 7.7 Run the success metric checks from the PRD:
    - `grep -r "catch {" src/ --include="*.ts" | grep -v test | wc -l` → expect 0
    - `grep -r "/secrets/values" src/ --include="*.ts" | wc -l` → expect 0
    - `grep -r "parseToolCall" src/ --include="*.ts" | grep -v test | wc -l` → expect 0
    - `wc -l src/agent/do.ts` → expect < 100
    - `wc -l src/integrations/slack.ts` → expect < 200
    - `grep -r "bge-small-en" src/ --include="*.ts" | grep -v test` → expect exactly 1 file
    - `grep -r "allowedCommand" src/ --include="*.ts" | wc -l` → expect 0
    - `grep -r "dailyTokenUsageLocal" src/ --include="*.ts" | wc -l` → expect 0
