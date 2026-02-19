# PRD: Migrate Blob Agent from Fly.io to Cloudflare

**Version:** 1.0
**Date:** 2026-02-19
**Status:** Draft

---

## 1. Introduction / Overview

Blob is a minimal self-modifying AI coding agent (~200 lines of core Python) currently deployed on Fly.io. It runs a ReAct loop (Reason → Act → Observe), executes bash commands in a sandboxed environment, modifies its own code with git-based safety controls, and communicates via Slack.

This project migrates Blob from its single-VM Fly.io deployment to Cloudflare's three-layer architecture: **Workers + Agents SDK** for orchestration, **Sandbox SDK (Containers)** for code execution, and **DO SQLite + R2** for persistent storage. The orchestration layer will be rewritten in TypeScript to fully embrace the Cloudflare Agents SDK. The execution layer retains Python inside sandbox containers. Safety enforcement moves to the orchestration layer where it cannot be bypassed.

---

## 2. Goals

1. **Rewrite orchestration in TypeScript** using the Cloudflare Agents SDK and Durable Objects, replacing `agent.py`, `llm_client.py`, `approval.py`, `safety.py`, `config.py`, `slack_bot.py`, and `tools.py`.
2. **Implement sandboxed code execution** via the Cloudflare Sandbox SDK, replacing the current `FlySpriteSandbox` with container-based bash/git/Python execution.
3. **Migrate storage to DO SQLite + R2**, replacing the Fly.io persistent volume. DO SQLite stores agent state, conversation history, rate limits, approval logs, and knowledge. R2 stores repository snapshots, documentation cache, and large artifacts.
4. **Switch Slack integration from Socket Mode to Events API** with HTTP webhooks handled natively by the Worker.
5. **Move all safety enforcement to the orchestration layer** (Worker/DO) so rate limiting, approval gates, and constitution enforcement cannot be bypassed from the sandbox.
6. **Achieve cost parity or improvement** targeting ~$10–20/month for moderate bursty usage.
7. **Maintain feature parity** with the current Fly.io deployment — the agent must be able to receive tasks via Slack, execute code, modify itself, run tests, rollback on failure, and learn across sessions.

---

## 3. User Stories

1. **As a user**, I can send a message to the Slack bot and receive a response powered by the Cloudflare-hosted agent, just as I do today.
2. **As a user**, I can submit a coding task via Slack and the agent executes bash commands, modifies code, runs tests, and reports results — all within a Cloudflare sandbox container.
3. **As a user**, I see approval requests in Slack for sensitive operations (core file modifications, deployments) and can approve/deny them via reactions, with the orchestration layer enforcing the decision.
4. **As a user**, I benefit from the agent's persistent memory (knowledge file, conversation history) surviving container restarts because state is stored in DO SQLite and R2.
5. **As a developer**, I can deploy the agent with `npx wrangler deploy` and manage configuration via `wrangler.toml` and Cloudflare secrets.
6. **As a developer**, I can run the orchestration layer locally using `wrangler dev` for development and testing.

---

## 4. Functional Requirements

1. **The system must** implement a TypeScript Worker entry point that handles incoming HTTP requests (Slack Events API webhooks, health checks).
2. **The system must** implement a Durable Object (using the Agents SDK `Agent` base class) that manages the full agent lifecycle: receiving tasks, calling the LLM, dispatching tool executions, and returning results.
3. **The system must** call the Anthropic API from the orchestration layer using `fetch()`, supporting both Haiku 4.5 (routine) and Sonnet 4.5 (complex) model routing, with prompt caching.
4. **The system must** implement the bash tool by forwarding commands to a Sandbox container via the Sandbox SDK (`sandbox.exec()`), with timeout enforcement and output truncation.
5. **The system must** manage sandbox container lifecycle: create on task start, keep alive during execution, allow scale-to-zero on idle.
6. **The system must** persist agent state (conversation history, task logs, rate limit counters, approval records) in DO SQLite.
7. **The system must** persist repository snapshots and large artifacts in R2, and restore them into the sandbox container at session start.
8. **The system must** persist the knowledge file (`AGENT.md`) content in DO SQLite and sync it to/from the sandbox container filesystem when needed.
9. **The system must** enforce rate limits (3 self-modifications per session, 10 per day) in the orchestration layer using DO SQLite counters.
10. **The system must** enforce constitution rules (protected file list) in the orchestration layer, blocking tool calls that would modify core files without approval.
11. **The system must** implement approval gates in the orchestration layer: post approval requests to Slack, wait for reactions (with 30-minute timeout), and enforce the decision before forwarding commands to the sandbox.
12. **The system must** implement git safety in the sandbox: auto-commit after successful modifications, checkpoint before risky operations, and automatic rollback on test failure. The orchestration layer triggers these git operations via sandbox commands.
13. **The system must** verify Slack request signatures on incoming webhooks to prevent unauthorized access.
14. **The system must** map Slack threads to Durable Object instances (one DO per conversation thread) for stateful multi-turn interactions.
15. **The system must** support a maximum of 25 agent loop iterations per task (configurable).
16. **The system must** expose a health check endpoint at the Worker level.
17. **The system must** include a `wrangler.toml` configuration file defining the Worker, Durable Object bindings, R2 bucket bindings, and Sandbox bindings.

---

## 5. Non-Goals (Out of Scope)

1. **Multi-agent orchestration** — this migration is for a single agent instance. Multi-agent patterns are a future concern.
2. **AI Gateway integration** — LLM request proxying/caching via AI Gateway is a future optimization, not required for migration.
3. **Cloudflare Workflows** — the current agent loop fits within DO alarms; Workflows are not needed for v1.
4. **KV or D1 storage** — DO SQLite and R2 cover all current storage needs. KV and D1 are out of scope.
5. **Custom container images** — use the default Sandbox SDK container image; do not build custom Docker images for the sandbox.
6. **Web UI** — the agent is Slack-only. No web dashboard or chat interface.
7. **Migration of CI/CD** — the existing GitHub Actions workflow for Fly.io will be replaced, but designing a full CI/CD pipeline for Cloudflare is a follow-up task. Initial deployment is manual via `wrangler deploy`.
8. **Backward compatibility with Fly.io** — once migrated, the Fly.io deployment is decommissioned. No dual-running.

---

## 6. Design Considerations

### Three-Layer Architecture

```
┌─────────────────────────────────────────────┐
│          Slack (Events API webhooks)         │
└──────────────────┬──────────────────────────┘
                   │ HTTP POST
┌──────────────────▼──────────────────────────┐
│  ORCHESTRATION LAYER (Worker + Durable Object) │
│                                                │
│  - Slack webhook verification & routing        │
│  - Agent loop (LLM calls, tool dispatch)       │
│  - Safety enforcement (rate limits, approvals, │
│    constitution)                                │
│  - State management (DO SQLite)                │
│  - R2 read/write for repo snapshots            │
└──────────────────┬──────────────────────────┘
                   │ Sandbox SDK API
┌──────────────────▼──────────────────────────┐
│  EXECUTION LAYER (Sandbox Container)           │
│                                                │
│  - Bash command execution                      │
│  - Git operations (clone, commit, revert)      │
│  - Python/Node execution                       │
│  - File read/write                             │
│  - Test execution                              │
└────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Secrets stay in the orchestration layer.** The Anthropic API key, Slack tokens, and Cloudflare API token are Worker secrets — never passed to the sandbox.
- **The sandbox is stateless between sessions.** All durable state lives in DO SQLite or R2. At session start, the orchestration layer restores the workspace from R2 into the sandbox.
- **One Durable Object per Slack thread.** This gives each conversation its own isolated state, conversation history, and rate limit counters.
- **Approval gates are blocking.** The DO waits (using alarms for timeout) for Slack reaction callbacks before proceeding.

---

## 7. Technical Considerations

- **Sandbox SDK is in Beta.** Expect API changes. Pin SDK versions and wrap sandbox interactions behind an abstraction layer.
- **Cold starts.** Sandbox containers may take seconds to start from cold. Design the UX to post a "working on it" message to Slack immediately, then stream updates.
- **Container ephemerality.** Sandbox local disk may be lost on sleep. Always persist to R2 before allowing idle timeout.
- **Worker memory limit.** Workers are typically limited to 128 MB. Keep orchestration lean — no large file processing in the Worker. Stream large outputs from the sandbox.
- **Subrequest limits.** Default 10,000 per invocation on paid plans. A typical agent loop (25 iterations × ~3 calls each) is well within limits.
- **TypeScript project setup.** Use `wrangler init` patterns, with `src/` directory for Worker + DO code, compiled with esbuild (Wrangler's default bundler).

---

## 8. Success Metrics

1. **Feature parity:** All current agent capabilities (task execution, self-modification, approval gates, knowledge persistence, Slack interaction) work on Cloudflare.
2. **Test coverage:** All existing Python tests have equivalent TypeScript tests for the orchestration layer. Sandbox execution tests validate bash/git/Python operations.
3. **Cost:** Monthly cost at equivalent usage is ≤ $20/month (excluding LLM API costs).
4. **Cold start latency:** First response message posted to Slack within 5 seconds of receiving a task (even if sandbox is cold).
5. **Reliability:** Agent completes tasks without data loss across container restarts / scale-to-zero events.
6. **Deployment:** Single-command deployment via `npx wrangler deploy`.

---

## 9. Open Questions

1. **Sandbox SDK container image:** What base image does the Sandbox SDK provide? Does it include Python 3.11+, git, and pip out of the box, or do we need to install them at session start?
2. **R2 mount vs API:** Should the sandbox mount an R2 bucket for filesystem-like access, or should the orchestration layer handle R2 read/write and push files to the sandbox via `sandbox.writeFile()`?
3. **Slack Events API verification:** Does the Agents SDK provide helpers for Slack webhook signature verification, or do we implement it manually in the Worker fetch handler?
4. **DO SQLite schema evolution:** How do we handle schema migrations for DO SQLite as the agent evolves? Manual migration scripts, or an ORM/migration tool?
5. **Approval gate implementation:** Should approval waiting use DO alarms (poll for Slack reaction callbacks) or WebSocket hibernation patterns?
