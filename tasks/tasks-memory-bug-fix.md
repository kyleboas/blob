## Relevant Files

- `wrangler.agent.toml` - Add `[[vectorize]]` binding for `PI_VECTORS` and ensure the agent worker has access to the Vectorize index.
- `src/core/types.ts` - Confirm Env typing for `PI_VECTORS?: VectorizeIndex` (already present) and add any missing optional bindings used by the new memory pipeline.
- `src/integrations/slack.ts` - Implement message keyword commands: `settings`, `status`, `selftest`, plus `set minimal` / `set verbose`; enforce Minimal default and Verbose behavior.
- `src/agent/do.ts` - Persist per-conversation settings (verbosity), tool ledger ring buffer, last R2 flush timestamp, last Vectorize upsert/query status.
- `src/agent/pi-agent.ts` - Implement structured tool calling (preferred) + fallback parsing; repo bootstrap; tool ledger emission; learned memory capture; semantic recall injection.
- `src/integrations/sandbox.ts` - Remove `/workspace/blob` hardcode; parameterize workspace root to `/workspace/<repoDir>`; ensure safe path normalization remains.
- `src/core/memory.ts` - Extend memory helpers to write/read learned artifacts metadata and interact with DO for status reporting.
- `src/jobs/cron-jobs.ts` (and/or `src/jobs/*`) - If you choose periodic reconciliation for memory flush/indexing, implement or extend cron task(s).
- `docs/runbook.md` - Operational instructions for `settings/status/selftest`, troubleshooting, and required Cloudflare bindings (R2 + Vectorize).
- `docs/architecture.md` - Update memory architecture section: R2 artifacts + Vectorize index, plus Slack keyword commands and verbosity.
- `src/agent/pi-agent.test.ts` (new) - Unit tests for tool-call parsing (fallback) and structured tool-call handling (mocked).
- `src/integrations/sandbox.test.ts` (new or existing) - Unit tests for path normalization and workspace root handling.
- `src/integrations/slack.test.ts` (new) - Tests for keyword parsing and settings updates.
- `src/core/vectorize.test.ts` (new) - Unit tests for embedding/upsert/query helpers with mocked Env.

### Notes

- Unit tests should typically be placed alongside the code files they are testing.
- Use your existing test runner command (e.g., `npm test`). If using Jest, `npx jest [optional/path]` can run targeted tests.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file`

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [x] 0.0 Create feature branch
  - [x] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/tooling-memory-reliability`)

- [x] 1.0 Implement Slack message keyword commands and verbosity defaults
  - [x] 1.1 Update Slack message handling to detect exact keyword commands (case-insensitive, trimmed): `settings`, `status`, `selftest`.
  - [x] 1.2 Add detection for exact keyword commands: `set minimal` and `set verbose`.
  - [x] 1.3 Implement `settings` response (plain English): show current mode and how to change it (`set minimal`, `set verbose`).
  - [x] 1.4 Store verbosity setting per conversation in Durable Object state (default to `minimal` if unset).
  - [x] 1.5 Implement Minimal mode Slack output behavior:
    - Only short “working…” if needed + final response
    - No per-tool ledger messages
  - [x] 1.6 Implement Verbose mode Slack output behavior:
    - Emit a one-line tool ledger entry per tool call
    - Include short error summary on failures
  - [x] 1.7 Ensure keyword commands do not trigger when extra text is present (e.g., `status please` treated as normal chat).
  - [x] 1.8 Add/extend tests for keyword parsing and settings persistence (mock DO).

- [x] 2.0 Align workspace paths across agent + sandbox tools (`/workspace/<repoDir>`)
  - [x] 2.1 Refactor `src/integrations/sandbox.ts` to accept a `workspaceRoot` (or `repoDir`) for `readTool/writeTool/editTool/executeInSandbox`.
  - [x] 2.2 Update path normalization to allow relative paths under `/workspace/<repoDir>` (still block `..`, absolute paths, and empty paths).
  - [x] 2.3 Replace hardcoded `/workspace/blob/...` usage with `/workspace/<repoDir>/...` derived from the active repo.
  - [x] 2.4 Update `PiAgent` to compute and pass the correct `repoDir` consistently (already derived in `pi-agent.ts`, but must be used by tools).
  - [x] 2.5 Add unit tests for workspace root + path normalization (including allowed and rejected cases).

- [x] 3.0 Implement repo bootstrap in sandbox before tool usage
  - [x] 3.1 Define a bootstrap routine in `PiAgent` that runs before first tool call:
    - Ensure sandbox started/session available
    - Ensure `/workspace/<repoDir>` exists
  - [x] 3.2 Implement “clone if missing”:
    - If `/workspace/<repoDir>/.git` does not exist, `git clone` the repo URL into `/workspace/<repoDir>`.
  - [x] 3.3 Implement “update if present”:
    - `git fetch` + reset/pull to configured default branch/ref (choose simple default: origin/main, fallback origin/master).
  - [x] 3.4 Ensure `git` authentication works in sandbox (use existing `blob-git-askpass` + `GITHUB_TOKEN` pattern).
  - [x] 3.5 Record and report bootstrap failures clearly (error text included in final response; verbose mode can include bootstrap log excerpt).
  - [x] 3.6 Add a safe guard to avoid repeated clone/update in a single job (bootstrap once per run).
  - [x] 3.7 Add tests for bootstrap decision logic (mock bash exec; verify commands issued).

- [x] 4.0 Add robust tool calling (structured tool calls preferred; fallback parsing supported)
  - [x] 4.1 Define tool schemas for the 4 tools in `PiAgent`:
    - `read({ path })`
    - `write({ path, content })`
    - `edit({ path, oldText, newText })`
    - `bash({ command })`
  - [x] 4.2 Update LLM call wrapper to send tool definitions to the model/provider when supported (so real tool calls can be returned).
  - [x] 4.3 Implement structured tool-call handling:
    - If response includes tool calls, execute them directly (do not rely on regex parsing).
    - Convert tool results into model-visible tool result messages.
  - [x] 4.4 Keep and harden fallback parsing (`TOOL:` / `ARG:`) for providers/models that do not return tool calls.
  - [x] 4.5 Ensure the agent loop always logs tool calls into a tool ledger (name, args summary, ok/fail, duration, error summary).
  - [x] 4.6 Wire tool ledger emission to Slack based on verbosity setting (Minimal suppresses per-tool posts; Verbose posts them).
  - [x] 4.7 Add unit tests:
    - Fallback parser correctness
    - Structured tool-call flow (mocked provider response)
    - Tool ledger entries created for each call

- [ ] 5.0 Implement durable “learned memory” persistence to R2 and status reporting
  - [ ] 5.1 Define a “learned record” JSON shape (timestamp, conversation key, summary, tags, optional source refs).
  - [ ] 5.2 Append learned records to a local sandbox file (e.g., `/workspace/blob_state/learned.jsonl`) at end-of-job.
  - [ ] 5.3 Flush learned artifacts to R2:
    - Choose stable key format, e.g. `memory/<conversationKey>/<YYYY-MM-DD>/learned.jsonl` or per-record objects.
  - [ ] 5.4 Persist last R2 flush time + count/last record metadata in DO state for `status`.
  - [ ] 5.5 Implement `status` output fields for R2 learned memory:
    - last flush time
    - count since last flush (or last known count)
  - [ ] 5.6 Add tests for learned record creation and DO metadata updates (mock R2 + DO fetch).

- [ ] 6.0 Add Cloudflare Vectorize semantic memory (bindings + embeddings + upsert + query + context injection)
  - [ ] 6.1 Add Vectorize binding to `wrangler.agent.toml`:
    - `[[vectorize]]`
    - `binding = "PI_VECTORS"`
    - `index_name = "<your-index-name>"`
  - [ ] 6.2 Implement embedding helper using Workers AI (`env.AI.run` with an embedding-capable model) to convert text → vector.
  - [ ] 6.3 Implement Vectorize upsert helper:
    - Use a stable vector id scheme (e.g., `conv:<conversationKey>:<timestamp>`).
    - Store metadata that references the R2 key (do not store full content in Vectorize).
  - [ ] 6.4 Implement Vectorize query helper:
    - Embed query text
    - Query Vectorize for top K results
    - Return metadata references (R2 keys + short snippet, if stored separately)
  - [ ] 6.5 Decide what to inject into model context:
    - Fetch referenced artifact(s) from R2 (or a stored snippet field) and inject only a capped amount.
  - [ ] 6.6 Integrate semantic recall into request handling:
    - For normal chat/tool runs, query Vectorize using the user message and inject top-K relevant memory into the prompt/context builder.
    - Enforce caps (e.g., K=5, max chars total) to avoid context bloat.
  - [ ] 6.7 Track Vectorize health metadata in DO state:
    - last upsert timestamp + success/failure
    - last query timestamp + result count
  - [ ] 6.8 Add unit tests for embedding/upsert/query helpers using mocks for `env.AI` and `env.PI_VECTORS`.

- [ ] 7.0 Extend `selftest` to validate R2 + Vectorize end-to-end
  - [ ] 7.1 Implement `selftest` command handler flow:
    - Run repo bootstrap
    - Perform read/write/edit/bash validations using safe test file (e.g., `.blob/selftest.txt`)
  - [ ] 7.2 Add learned record generation as part of selftest, flush to R2, and verify read-back/metadata.
  - [ ] 7.3 Add Vectorize portion of selftest:
    - Embed learned text
    - Upsert into Vectorize with metadata referencing the R2 key
    - Query Vectorize for a term unique to the learned record
    - Confirm the inserted record is returned (match vector id or metadata).
  - [ ] 7.4 Ensure selftest does not modify user code:
    - Create `.blob/` directory if missing
    - Only touch `.blob/selftest.txt` (or similar) and optional `.blob/selftest.log`
  - [ ] 7.5 Ensure `selftest` output is concise in Minimal mode and includes step-by-step ledger in Verbose mode.
  - [ ] 7.6 Add tests for selftest command routing and step sequencing (mock tool exec + R2 + Vectorize).

- [ ] 8.0 Add tests, docs, and runbook updates
  - [ ] 8.1 Update `docs/architecture.md` to reflect:
    - Slack keyword commands
    - verbosity settings
    - memory pipeline: R2 artifacts + Vectorize semantic index
  - [ ] 8.2 Update `docs/runbook.md` with:
    - How to use `settings`, `status`, `selftest`
    - How to configure Vectorize binding and index name
    - Common failure modes (missing binding, embedding model errors, sandbox auth issues)
  - [ ] 8.3 Add/confirm unit tests run in CI (ensure test command includes new tests).
  - [ ] 8.4 Add a short “smoke test” checklist to docs for manual validation in Slack.