# PRD: Self-Modifying AI Agent v0.1

## 1. Introduction / Overview

This project builds a **minimal, self-improving AI agent** that can safely write and modify its own code. The agent runs a ReAct loop (Reason → Act → Observe) powered by an LLM, executes commands through a sandboxed bash tool, uses git as a safety net and audit trail, and persists learnings in a knowledge file (`AGENT.md`) that compounds across sessions.

The architecture is deliberately minimal — research shows that ~100 lines of Python with bash access can rival complex multi-tool agent frameworks (Princeton's Mini-SWE-Agent scores >74% on SWE-bench). The engineering challenge is not the agent loop itself but the security boundary around it.

v0.1 covers the full end-to-end pipeline: agent loop, sandboxed execution via Fly.io Sprites, git-based safety, a self-improvement cycle, documentation ingestion, and production deployment on Fly.io.

## 2. Goals

1. **Deliver a working self-modifying agent in under 200 lines of core Python** (excluding sandbox and deployment config).
2. **Achieve hardware-level isolation** for all agent-executed code using Fly.io Sprites (Firecracker microVMs).
3. **Ensure every code change is recoverable** via automatic git commits, tagged checkpoints, and auto-revert on test failure.
4. **Support multi-model routing** through an abstraction layer — Anthropic (Claude Haiku 4.5 / Sonnet 4.5) as the primary provider, with the ability to add OpenAI or other providers later.
5. **Enable compound learning** — the agent updates a persistent `AGENT.md` knowledge file after each session so that each improvement makes future improvements easier.
6. **Deploy to Fly.io** with scale-to-zero, persistent storage, and Firecracker-based isolation, targeting a monthly infrastructure cost of $3–15.
7. **Keep total monthly operating cost under $65** at medium activity levels (LLM API + infrastructure).

## 3. User Stories

1. **As a developer**, I want to message the agent in a Slack channel with a task (e.g., "add a new tool for file search") and have it plan, implement, test, and commit the change — so I can extend the agent's capabilities without writing all the code myself.
2. **As a developer**, I want the agent to send me a Slack message asking for my explicit approval before modifying its own core code — so I maintain control over what changes are applied.
3. **As a developer**, I want every agent modification auto-committed to git with a descriptive message — so I can review, diff, and revert any change instantly.
4. **As a developer**, I want the agent to automatically roll back changes when tests fail — so a bad self-modification never breaks the system.
5. **As a developer**, I want the agent to remember what it learned across sessions via `AGENT.md` — so it doesn't repeat mistakes and builds on prior knowledge.
6. **As a developer**, I want to deploy the agent to Fly.io and trigger sessions from Slack — so it can run autonomously in a secure, isolated environment.
7. **As a developer**, I want the agent to post progress updates and results back to the Slack thread where I gave it the task — so I can follow along without switching tools.
8. **As a developer**, I want the agent to fetch and cache documentation from allowlisted domains — so it can learn new API patterns and propose improvements based on up-to-date information.
9. **As a developer**, I want to configure which LLM model handles which task tier — so I can optimize cost vs. quality tradeoffs.

## 4. Functional Requirements

### 4.1 Agent Loop (Core)

1. The system must implement a ReAct loop: send conversation history + tool definitions to the LLM, parse tool_use responses, execute tools, append results, and repeat.
2. The system must support a configurable `MAX_STEPS` limit (default: 25) to prevent runaway loops.
3. The system must load the contents of `AGENT.md` into the system prompt at the start of every session.
4. The system must reset conversation context after each completed task to prevent confusion accumulation.
5. The system must expose `bash` as the primary tool, with a JSON schema defining a `command` string input.

### 4.2 Sandboxed Execution

6. The system must execute all bash commands inside a Fly.io Sprite (Firecracker microVM).
7. The system must enforce a default command timeout of 30 seconds (configurable).
8. The system must enforce a memory limit of 512 MB per sandbox instance.
9. The system must apply a deny-all network policy, allowlisting only: `api.anthropic.com`, `*.pypi.org`, `files.pythonhosted.org`, and `docs.anthropic.com`.
10. The system must block access to private network ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), localhost, and cloud metadata services.

### 4.3 Git-Based Safety

11. The system must auto-commit with a descriptive message after every successful file modification.
12. The system must create a tagged git checkpoint before any self-modification attempt.
13. The system must auto-revert to the last checkpoint when tests fail after a modification.
14. The system must expose `git log --oneline` output to the agent so it can reason about its version history.
15. The system must maintain an immutable audit trail of all changes.

### 4.4 Human-in-the-Loop Approval

16. The system must implement a three-tier permission model:
    - **Auto-approve**: read-only operations, git status checks, safe queries.
    - **Conditional**: file edits within the workspace, test execution, package installation.
    - **Always-require-approval**: modifications to agent core code, system prompt changes, network configuration changes, destructive operations.
17. The system must send a Slack message to the operator with the proposed action and wait for an emoji reaction or threaded reply (`approve` / `reject`) before applying any change to agent core files (`agent.py`, `sandbox.py`, `tools.py`, system prompt).
18. The approval interface must be designed behind an abstraction (`ApprovalGate` ABC) so Slack can be swapped for CLI stdin, webhook, or PR-based approval if needed.
19. The system must enforce an approval timeout (default: 30 minutes). If no response is received, the action is auto-rejected and the agent moves on.

### 4.5 Self-Modification Controls

19. The system must enforce a per-session self-modification limit (default: 3).
20. The system must enforce a per-day self-modification limit (default: 10).
21. The system must run the full test suite after every self-modification.
22. The system must automatically roll back and log when tests fail or benchmark scores regress after a modification.
23. The system must protect immutable "constitution" files (core safety logic, permission system, rate-limit configuration) that the agent can never modify.

### 4.6 LLM Provider Abstraction

24. The system must use Anthropic as the primary LLM provider (Claude Haiku 4.5 for routine tasks, Claude Sonnet 4.5 for complex reasoning).
25. The system must implement an LLM client abstraction layer that accepts a model identifier and returns a standard response format, enabling future providers to be added without changing agent logic.
26. The system must leverage Anthropic prompt caching — structuring requests with static content first (system prompt, tool definitions, cached docs) followed by dynamic content.
27. The system must support configurable model routing rules to assign task tiers to specific models.

### 4.7 Knowledge & Documentation

28. The system must update `AGENT.md` at the end of each session with patterns, gotchas, and learnings discovered during the session.
29. The system must fetch and cache documentation from allowlisted domains, storing results as markdown files in a `docs/` directory.
30. The system must treat all fetched external content as untrusted — never injecting raw external input into system/developer messages or self-modification decisions.

### 4.8 Slack Integration

31. The system must run a Slack bot (using Slack's Bolt SDK) that listens for messages in a designated channel or direct messages.
32. The system must start an agent session when a user sends a task message, posting a threaded acknowledgment immediately.
33. The system must post progress updates to the Slack thread as the agent executes (e.g., "Running tests...", "Committing changes...").
34. The system must post the agent's final result (success summary or failure reason) back to the Slack thread when the session completes.
35. The system must support approval requests via Slack: post the proposed action to the thread and wait for an emoji reaction (`:white_check_mark:` to approve, `:x:` to reject) or a threaded reply containing "approve" or "reject".
36. The system must associate each Slack thread with exactly one agent session to prevent cross-talk.

### 4.9 Task Management

37. The system must read tasks from a `tasks.json` file.
38. The system must execute the improvement cycle: pick next task → read docs → plan → write code → test → commit + update `AGENT.md` (on pass) or rollback + log (on fail).

### 4.10 Deployment

39. The system must be deployable to Fly.io via a `Dockerfile` and `fly.toml`.
40. The system must use a persistent Fly.io volume for the git repo, knowledge files, and cached docs.
41. The system must store API keys (including `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`) as environment variables (never in code or committed files).
42. The system must enable `auto_stop_machines` for scale-to-zero when idle.
43. The system must keep the Slack bot process running as the primary entrypoint, spawning agent sessions as background tasks when triggered by Slack messages.

## 5. Non-Goals (Out of Scope)

- **Multi-agent orchestration** — v0.1 is a single-agent system. Multi-agent splitting is deferred until evaluations demonstrate the need.
- **Web UI or dashboard** — interaction is Slack only; no web frontend.
- **Vector-store-based persistent memory** — deferred to v0.2+. v0.1 uses `AGENT.md` as flat-file memory.
- **Structured tools beyond bash** — v0.1 uses bash as the sole tool. Dedicated file-read, file-write, and web-fetch tools are deferred to v0.2+.
- **OpenAI or third-party LLM support in v0.1** — the abstraction layer is built, but only the Anthropic adapter is implemented.
- **Automated benchmarking / scoring** — deferred to v0.2+. v0.1 relies on test pass/fail as the quality gate.
- **Self-hosted Firecracker / jailer management** — handled by Fly.io Sprites.

## 6. Design Considerations

- **Ruthless minimalism**: the research proves that elaborate scaffolding is unnecessary. Aim for the smallest amount of code that achieves each requirement.
- **Separation of concerns**: keep the agent loop (`agent.py`), sandbox (`sandbox.py`), tool definitions (`tools.py`), and knowledge file (`AGENT.md`) as distinct modules.
- **Immutable safety core**: the permission system, rate limits, and safety logic should be in files the agent is constitutionally forbidden from modifying.
- **Pluggable approval interface**: design the approval gate as a callable (e.g., `ApprovalGate` protocol/ABC) so Slack can be swapped for CLI stdin, HTTP, or PR-based gates if needed.
- **Slack as the control plane**: all human interaction (task submission, approval, progress monitoring, results) flows through Slack threads. The agent has no CLI interaction mode in production.

## 7. Technical Considerations

- **Language**: Python (first-class Anthropic SDK, trivial self-modification via `open(__file__)` / `importlib.reload()`).
- **Dependencies**: `anthropic` SDK, `slack-bolt` + `slack-sdk` (Slack bot), `docker` Python SDK (dev only), `flyctl` CLI (deployment).
- **Sandbox**: Fly.io Sprites (Firecracker microVMs) with deny-all networking + allowlist.
- **Prompt caching**: structure all LLM requests with static content first to maximize Anthropic's 90% cache-read discount.
- **Security**: never inject raw external content into system messages; validate all external input; run command-injection detection on bash commands.
- **Project structure**:
  ```
  /
  ├── agent.py          # Core ReAct loop
  ├── sandbox.py        # Fly.io Sprite / Docker executor
  ├── tools.py          # Tool definitions + schemas
  ├── llm_client.py     # LLM provider abstraction layer
  ├── approval.py       # Human-in-the-loop approval gate (Slack-based)
  ├── slack_bot.py      # Slack Bolt app: event listeners, session dispatch
  ├── safety.py         # Git safety, rate limits, constitution
  ├── config.py         # Configuration constants + env loading
  ├── tasks.json        # Task queue for self-improvement
  ├── AGENT.md          # Persistent knowledge file
  ├── docs/             # Cached documentation
  ├── tests/            # Test suite
  ├── Dockerfile        # Container image for Fly.io
  ├── fly.toml          # Fly.io configuration
  └── pyproject.toml    # Project metadata + dependencies
  ```

## 8. Success Metrics

| Metric | Target |
|---|---|
| Core agent loop lines of code | < 200 (excluding sandbox, config, tests) |
| Agent can complete a simple self-assigned task (e.g., add a new bash alias tool) | Yes / No |
| All bash commands execute inside Firecracker microVM | 100% |
| Every file modification has a corresponding git commit | 100% |
| Auto-revert triggers on test failure after self-modification | 100% |
| Self-modification rate limits enforced | Per-session: 3, Per-day: 10 |
| Monthly infrastructure cost (Fly.io) | $3–15 |
| Monthly total cost (LLM + infra) at medium activity | < $65 |
| Agent reads and updates `AGENT.md` each session | 100% |
| Time from `flyctl deploy` to working agent | < 5 minutes |
| Slack message to agent response (simple task) | < 60 seconds |
| Approval request to Slack delivery | < 2 seconds |

## 9. Open Questions

1. **Fly.io Sprites API stability**: Sprites is a newer Fly.io feature — should we have a Docker fallback for sandbox execution in case the API changes?
2. **Test suite bootstrapping**: what initial tests should ship with v0.1 to validate agent behavior before the agent starts writing its own tests?
3. **Slack app distribution**: should the Slack app be a single-workspace install, or designed for multi-workspace distribution from the start?
4. **Constitution file format**: should immutable files be enforced via filesystem permissions (read-only), git hooks (reject commits touching them), or application-level checks, or a combination?
5. **`AGENT.md` growth management**: as the knowledge file grows over many sessions, how should it be pruned or summarized to stay within context window limits?
