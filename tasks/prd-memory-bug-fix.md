## 1. Introduction/Overview

Blob is a Slack-driven autonomous coding worker running on Cloudflare Workers + Durable Objects + Cloudflare Sandbox. Today, Blob often feels like it “doesn’t know” it can use its tools (sandbox + filesystem + bash), and it is unclear whether memory is being updated and persisted.

This feature set improves reliability and observability by:
- Making tool execution (read/write/edit/bash) consistent and aligned with the repo workspace path.
- Ensuring repos are bootstrapped (cloned/updated) inside the sandbox before tools run.
- Persisting “learned” memory in a durable, inspectable way (R2 as source of truth).
- **Indexing and retrieving semantic memory via Cloudflare Vectorize** (R2 stores full artifacts; Vectorize stores searchable references).
- Providing Slack visibility and Slack message-keyword commands for status plus a self-test command.
- Using a robust tool-calling mechanism (prefer native structured tool calls; allow fallback if needed).

This PRD assumes the repo workspace layout is `/workspace/<repoDir>` (where `repoDir` is derived from `owner/name`).

## 2. Goals (specific + measurable)

1. Tool reliability:
   - Blob must successfully run `read`, `write`, `edit`, and `bash` against the active repo inside sandbox with the repo located at `/workspace/<repoDir>`.
   - Blob must automatically bootstrap the repo (clone if missing; update if present) before the first tool call for a request.

2. Memory reliability (durable artifacts + semantic index):
   - Blob must write an end-of-job “learned” record to a local sandbox file and flush it to R2.
   - Blob must upsert semantic memory references into Cloudflare Vectorize for retrieval in future conversations.
   - Blob must be able to show last memory flush timestamp and Vectorize indexing status via a Slack message keyword `status`.

3. Observability:
   - Blob must default to **Minimal** Slack output.
   - Blob must support **Minimal/Verbose** mode configured via plain-English settings messages.
   - Blob must provide Slack message keywords:
     - `settings` (configure Minimal/Verbose mode)
     - `status` (health + recent tool calls + memory state)
     - `selftest` (end-to-end tool + memory test)

4. Tool calling robustness:
   - Blob must prefer native structured tool calls when the model/provider supports it.
   - Blob must include a fallback tool-call parsing mode (text “TOOL/ARG”) to avoid total failure if structured tool calls are unavailable.

## 3. User Stories

1. As a user chatting in Slack, I want Blob to clearly show when it is using tools (when I opt into Verbose) so I can trust it is actually executing work.
2. As a user, I want Blob to reliably operate on my repo in the sandbox without manual setup or path confusion.
3. As a user, I want Blob to persist memory (learned notes) so it can recall what it learned later.
4. As a user, I want that recall to be semantic (Vectorize), not only “last 20 messages.”
5. As a user, I want to type `settings` to see and change how chatty Blob is (Minimal vs Verbose) using plain English.
6. As a user, I want to type `status` to quickly see whether sandbox/tools/memory/Vectorize are working.
7. As a user, I want to type `selftest` to prove the system is correctly wired end-to-end.

## 4. Functional Requirements

1. Workspace alignment
   1.1 The system must use a single authoritative workspace root for repo operations: `/workspace/<repoDir>`.
   1.2 The system must ensure all tool functions (`read`, `write`, `edit`, `bash`) operate against that same workspace root.

2. Repo bootstrap
   2.1 The system must ensure the repo exists in the sandbox before the first tool call (clone if missing).
   2.2 The system must update the repo to a known ref/branch when configured (e.g., default branch), without requiring user interaction.
   2.3 The system must fail gracefully and report a clear error if repo bootstrap fails.

3. Tool calling
   3.1 The system must expose exactly four tools to the agent: `read`, `write`, `edit`, and `bash`.
   3.2 The system must support native structured tool calling for these tools (name + JSON schema + returned results).
   3.3 The system must support a fallback mode that parses tool calls from text (TOOL/ARG) if structured tool calls are not available.
   3.4 The system must record a tool call ledger entry for every attempted tool call, including success/failure and duration.

4. Slack message keyword commands (NOT slash commands)
   4.1 The system must detect the message keyword `settings` (case-insensitive, leading/trailing whitespace ignored).
   4.2 The system must detect the message keyword `status` (case-insensitive, leading/trailing whitespace ignored).
   4.3 The system must detect the message keyword `selftest` (case-insensitive, leading/trailing whitespace ignored).
   4.4 The system must treat these keywords as commands only when the message is exactly the keyword (no extra text).
       - Example: `status` triggers the status response.
       - Example: `status please` does NOT trigger the status command (handled as normal chat).

5. Settings (plain English)
   5.1 The system must store a per-conversation setting `verbosity` with allowed values: `minimal` and `verbose`.
   5.2 The default `verbosity` must be `minimal`.
   5.3 When the user sends `settings`, the system must respond with:
       - Current verbosity
       - Plain-English instructions for changing it, including at least these accepted commands:
         - `set minimal`
         - `set verbose`
   5.4 When the user sends `set minimal` or `set verbose`, the system must update the stored setting and confirm the new value.
   5.5 The system must persist this setting in the conversation Durable Object state so it survives restarts.

6. Slack visibility behavior (Minimal vs Verbose)
   6.1 In Minimal mode, the system must:
       - Post only: (a) a short “working…” acknowledgement if needed, and (b) the final answer/summary.
       - Avoid posting one-line tool ledger messages for each tool call.
   6.2 In Verbose mode, the system must:
       - Post a tool ledger line to Slack for every tool call, including tool name + ok/fail + duration.
       - On failure, include a short error summary (e.g., stderr excerpt) without dumping huge logs.

7. Status output
   7.1 When the user sends `status`, the system must return:
       - Sandbox started/ready state
       - Repo workspace path (`/workspace/<repoDir>`)
       - Recent tool calls (last N, e.g., 10): tool name + ok/fail + duration
       - Durable memory: last R2 flush time + count of learned entries since last flush (or last known summary)
       - **Vectorize memory: last index update time, last upsert result (success/failure), and last query count (if available)**

8. Self-test behavior (must include Vectorize)
   8.1 When the user sends `selftest`, the system must:
       - Bootstrap repo
       - Read a known file (e.g., README.md)
       - Perform a safe write/edit that does not modify user code (use a dedicated test file like `.blob/selftest.txt`)
       - Run a harmless bash command (e.g., `node -v`)
       - Write a learned record
       - Verify learned record persisted to R2 (via read-back or metadata check)
       - **Generate embeddings (using Workers AI) and upsert a Vectorize record referencing the R2 artifact**
       - **Query Vectorize for a known term from the learned record and confirm it returns the inserted reference**
       - Report pass/fail with concise details

9. Memory persistence (R2)
   9.1 The system must append a learned record at the end of a job to a local sandbox file (e.g., `/workspace/blob_state/learned.jsonl`).
   9.2 The system must flush the learned file to R2 at end-of-job (or on a schedule) and record the flush timestamp in DO state.
   9.3 The system must support reading recent learned entries (from R2 or cached state) for `status`.

10. Semantic memory (Vectorize)
   10.1 The system must define a Vectorize binding (e.g., `PI_VECTORS`) in the agent worker configuration.
   10.2 The system must store full memory artifacts in R2 and store only lightweight references/metadata in Vectorize (e.g., R2 key, timestamp, conversation key, tags).
   10.3 The system must embed memory text using Workers AI embeddings and upsert vectors into Vectorize.
   10.4 The system must retrieve semantic memory by querying Vectorize during prompt/context construction, and include the top K relevant memory snippets/references.
   10.5 The system must cap semantic memory injection to prevent context bloat (e.g., top K=5; max total characters).

11. Configuration and safety
   11.1 The system must block obviously dangerous bash commands as already implemented (retain existing safeguards).
   11.2 The system must avoid modifying user code during self-test by default; it must use a dedicated safe test file or a temporary file.

## 5. Non-Goals (Out of Scope)

- Adding new tools beyond the four core tools.
- Implementing a full web UI or dashboard (Slack-only for this feature).
- Creating or merging GitHub PRs as part of this feature (unless already existing work).
- Building a complex, multi-tier memory “brain”; keep memory pipeline simple: R2 artifacts + Vectorize index.

## 6. Design Considerations (optional)

- Slack outputs must be readable:
  - Minimal mode: minimal chatter.
  - Verbose mode: tool ledger lines are one line each, with short failure excerpts only.
- Settings must be plain English and easy to discover via the `settings` keyword.
- Semantic memory should avoid flooding context; include only the most relevant items.

## 7. Technical Considerations (optional)

- Keep tool execution deterministic by enforcing a single workspace root.
- Prefer structured tool calling where the provider supports it, but keep fallback parsing to prevent “silent no-tools” behavior.
- Use Durable Object state to store:
  - per-conversation verbosity setting
  - recent tool ledger entries (ring buffer)
  - last R2 flush timestamp
  - last Vectorize upsert status + timestamp
- Embeddings should use Workers AI embedding models (via `env.AI.run(...)`) so you don’t add new external services.

## 8. Success Metrics

- `selftest` passes reliably (≥ 95% success across repeated runs) for:
  - repo bootstrap
  - read/write/edit/bash
  - learned memory flush to R2
  - embedding generation + Vectorize upsert + Vectorize query hit
- User can run `status` and see:
  - repo path
  - recent tool calls
  - last R2 flush time
  - Vectorize upsert/query health indicators
- Minimal mode is the default and is noticeably less noisy than Verbose mode.
- Blob uses semantic retrieval (Vectorize) to answer questions that require older context, without relying only on “last N messages.”

## 9. Open Questions

1. Which embedding model should be used via Workers AI (and what dimensionality is required for your Vectorize index)?
2. What branch/ref should repo bootstrap default to (main/master/configurable)?
3. Where should the learned memory flush be triggered (end-of-job only vs also periodic cron)?
4. Should semantic memory be scoped to thread only, or should it also search across channel/DM scopes?