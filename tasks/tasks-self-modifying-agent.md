# Tasks: Self-Modifying AI Agent v0.1

## Relevant Files

- `pyproject.toml` - Project metadata, dependencies (`anthropic`, `pytest`), and script entrypoints.
- `config.py` - Configuration constants (MAX_STEPS, timeouts, rate limits), env var loading, constitution file list, and network allowlist.
- `config.py` → `tests/test_config.py` - Unit tests for configuration loading and validation.
- `llm_client.py` - LLM provider abstraction: base protocol/ABC, Anthropic adapter, prompt caching setup, model routing.
- `tests/test_llm_client.py` - Unit tests for LLM client abstraction (mocked API calls, routing logic).
- `sandbox.py` - Sandboxed command executor: Fly.io Sprite integration, timeout enforcement, memory limits, network policy.
- `tests/test_sandbox.py` - Unit tests for sandbox executor (command execution, timeout handling, error cases).
- `tools.py` - Bash tool JSON schema definition and tool-result formatting helpers.
- `tests/test_tools.py` - Unit tests for tool schema validation and result formatting.
- `agent.py` - Core ReAct loop: conversation management, tool dispatch, AGENT.md loading, step limiting, session reset.
- `tests/test_agent.py` - Unit tests for agent loop logic (mocked LLM, tool dispatch, step limits, stop conditions).
- `safety.py` - Git auto-commit, checkpoint tagging, auto-revert, constitution enforcement, self-modification rate limits.
- `tests/test_safety.py` - Unit tests for git safety operations, rate limiting, and constitution checks.
- `approval.py` - Approval gate ABC/protocol + CLI stdin implementation, three-tier permission classification.
- `tests/test_approval.py` - Unit tests for approval gate (permission tier classification, mock stdin approval).
- `tasks.json` - Task queue for the self-improvement loop (initial seed tasks).
- `AGENT.md` - Persistent knowledge file, seeded with initial project context.
- `docs/` - Directory for cached documentation fetched from allowlisted domains.
- `Dockerfile` - Multi-stage build for Fly.io deployment (Python runtime + flyctl).
- `fly.toml` - Fly.io app config: machine size, volumes, auto_stop, env vars, health checks.
- `.env.example` - Template for required environment variables (ANTHROPIC_API_KEY, etc.).
- `.gitignore` - Ignore patterns for .env, __pycache__, .pytest_cache, docs cache.

### Notes

- Unit tests should be placed in the `tests/` directory, mirroring the module they test (e.g., `tests/test_agent.py` for `agent.py`).
- Use `pytest` to run tests: `pytest tests/` for all, or `pytest tests/test_agent.py` for a specific module.
- The project uses Python with the `anthropic` SDK as the primary dependency.
- All commands the agent executes run inside a sandbox (Fly.io Sprite or Docker fallback). Never run agent-generated commands on the host.
- Constitution files (`safety.py`, `approval.py`, `config.py`) must be protected from agent self-modification.
- Prompt caching requires static content (system prompt, tool defs) to appear first in every LLM request.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/self-modifying-agent`)

- [ ] 1.0 Set up project skeleton and configuration
  - [ ] 1.1 Create `pyproject.toml` with project metadata, Python >=3.11 requirement, and dependencies: `anthropic`, `pytest`, `python-dotenv`
  - [ ] 1.2 Create `.gitignore` with patterns for `.env`, `__pycache__/`, `.pytest_cache/`, `docs/*.cached.md`, and IDE files
  - [ ] 1.3 Create `.env.example` listing required env vars: `ANTHROPIC_API_KEY`, `FLY_API_TOKEN`, `AGENT_ENV` (dev/prod)
  - [ ] 1.4 Create `config.py` with all configuration constants: `MAX_STEPS=25`, `COMMAND_TIMEOUT=30`, `MEMORY_LIMIT_MB=512`, `SELF_MODIFY_LIMIT_SESSION=3`, `SELF_MODIFY_LIMIT_DAY=10`, network allowlist, and constitution file list. Load overrides from environment variables.
  - [ ] 1.5 Create the initial `AGENT.md` knowledge file with a header, project description, and empty sections for Patterns, Gotchas, and Session Log
  - [ ] 1.6 Create an empty `tasks.json` with one seed task (e.g., "Add a hello-world bash alias tool")
  - [ ] 1.7 Create `docs/` directory with a `.gitkeep` file
  - [ ] 1.8 Create `tests/__init__.py` and verify `pytest tests/` runs with no errors

- [ ] 2.0 Implement the LLM provider abstraction layer
  - [ ] 2.1 Define an `LLMClient` protocol/ABC in `llm_client.py` with a `create_message(model, system, messages, tools) -> LLMResponse` method and a standardized `LLMResponse` dataclass (content blocks, stop_reason, usage)
  - [ ] 2.2 Implement `AnthropicClient(LLMClient)` that wraps the `anthropic` SDK, calling `client.messages.create()` and mapping the response to `LLMResponse`
  - [ ] 2.3 Add prompt caching support: ensure static content (system prompt, tool definitions) is placed first in every request with appropriate cache control headers
  - [ ] 2.4 Implement model routing: add a `get_model_for_tier(tier: str) -> str` function that maps "routine" → Haiku 4.5, "complex" → Sonnet 4.5, with tier-to-model mappings configurable in `config.py`
  - [ ] 2.5 Write `tests/test_llm_client.py`: test `LLMResponse` dataclass construction, model routing logic, and `AnthropicClient` with a mocked `anthropic.Anthropic` client

- [ ] 3.0 Build the sandboxed command executor
  - [ ] 3.1 Define a `SandboxExecutor` protocol/ABC in `sandbox.py` with `execute(command: str, timeout: int) -> ExecutionResult` and `ExecutionResult` dataclass (stdout, stderr, exit_code, timed_out)
  - [ ] 3.2 Implement `FlySpriteSandbox(SandboxExecutor)` that provisions/reuses a Fly.io Sprite machine, sends commands via the Machines API, and enforces the configured timeout and memory limit
  - [ ] 3.3 Configure deny-all network policy with allowlist for `api.anthropic.com`, `*.pypi.org`, `files.pythonhosted.org`, `docs.anthropic.com` in the Sprite machine config
  - [ ] 3.4 Add command-injection detection: scan incoming commands for suspicious patterns (e.g., attempts to curl non-allowlisted hosts, modify `/etc/resolv.conf`, access cloud metadata endpoints) and reject or flag them
  - [ ] 3.5 Implement output truncation: cap stdout/stderr at a configurable max length (default 10,000 chars) to prevent context window overflow
  - [ ] 3.6 Write `tests/test_sandbox.py`: test `ExecutionResult` construction, timeout handling logic, command-injection detection patterns, and output truncation

- [ ] 4.0 Implement the core agent ReAct loop
  - [ ] 4.1 Create `tools.py` with the bash tool definition: name, description, and JSON schema (`{"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}`). Add a `format_tool_result(tool_use_id, output) -> dict` helper
  - [ ] 4.2 Implement the main loop in `agent.py`: load `AGENT.md` into the system prompt, initialize conversation history, and enter the `while not done and steps < MAX_STEPS` loop
  - [ ] 4.3 In the loop body: call `llm_client.create_message()`, iterate over response content blocks, dispatch `tool_use` blocks to the sandbox executor, and append `tool_result` messages back to conversation history
  - [ ] 4.4 Handle the stop condition: when `stop_reason == "end_turn"` with no tool_use blocks, set `done = True` and capture the agent's final text response
  - [ ] 4.5 Add a CLI entrypoint: `python agent.py "task description"` that accepts a task string, runs the loop, and prints the result. Wire this up as a script in `pyproject.toml`
  - [ ] 4.6 Add conversation context reset: after each completed task, clear conversation history but preserve the system prompt and `AGENT.md` content
  - [ ] 4.7 Write `tests/test_agent.py`: test loop termination on `end_turn`, step limit enforcement, tool dispatch routing, and conversation reset behavior using a mock LLM client

- [ ] 5.0 Add git-based safety, approval gates, and self-modification controls
  - [ ] 5.1 Implement `git_auto_commit(message: str)` in `safety.py`: stages all changes in the workspace and commits with the given message. Called after every successful file modification detected by the agent
  - [ ] 5.2 Implement `git_checkpoint(tag: str)` in `safety.py`: creates a tagged commit representing a known-good state before any self-modification attempt
  - [ ] 5.3 Implement `git_revert_to_checkpoint(tag: str)` in `safety.py`: hard-reverts the workspace to the given tag. Called automatically when tests fail after a self-modification
  - [ ] 5.4 Implement `git_history() -> str` in `safety.py`: returns `git log --oneline -20` output for the agent to read and reason about its version history
  - [ ] 5.5 Define the `ApprovalGate` ABC in `approval.py` with `request_approval(action_description: str, tier: str) -> bool`. Implement `CLIApprovalGate` that prints the action and reads `y/n` from stdin for "always-require-approval" tier, auto-approves for "auto-approve" tier, and optionally prompts for "conditional" tier
  - [ ] 5.6 Implement permission tier classification in `approval.py`: a function `classify_action(command: str, target_files: list[str]) -> str` that returns "auto-approve", "conditional", or "always-require-approval" based on whether the command is read-only, modifies workspace files, or touches constitution files
  - [ ] 5.7 Implement self-modification rate limiter in `safety.py`: track session and daily modification counts, persist daily count to a `.modify_count` file, reject modifications that exceed `SELF_MODIFY_LIMIT_SESSION` or `SELF_MODIFY_LIMIT_DAY`
  - [ ] 5.8 Implement constitution enforcement in `safety.py`: a `is_constitution_file(path: str) -> bool` check against the list in `config.py`. The agent loop must call this before any file write and block modifications to protected files
  - [ ] 5.9 Integrate safety into the agent loop: wire `git_auto_commit` after tool executions that modify files, call `classify_action` + `request_approval` before executing commands, and check rate limits before self-modification
  - [ ] 5.10 Write `tests/test_safety.py`: test auto-commit (mock git), checkpoint/revert flow, rate limiter counting and rejection, constitution file detection
  - [ ] 5.11 Write `tests/test_approval.py`: test tier classification for read-only, workspace-edit, and core-file-edit commands. Test `CLIApprovalGate` with mocked stdin

- [ ] 6.0 Build the self-improvement loop and documentation ingestion
  - [ ] 6.1 Implement task queue reader: load `tasks.json`, pick the next incomplete task, mark it in-progress, and pass it to the agent loop as the task description
  - [ ] 6.2 Implement the improvement cycle wrapper: for each task — create a checkpoint → run the agent loop → run `pytest tests/` inside the sandbox → if tests pass, commit and update `AGENT.md` → if tests fail, revert to checkpoint and log the failure
  - [ ] 6.3 Implement `AGENT.md` update logic: after a successful task, append a session entry with timestamp, task description, what changed, and any patterns/gotchas the agent discovered (extracted from the agent's final response)
  - [ ] 6.4 Implement documentation fetcher: a function that fetches a URL (from the allowlist only), converts HTML to markdown, and saves it to `docs/<domain>/<path>.md`. Run fetches inside the sandbox to isolate network access
  - [ ] 6.5 Implement doc ingestion into context: before a task that references external APIs, load relevant cached docs from `docs/` and include them as user-message context (not system-message, to maintain the untrusted-input boundary)
  - [ ] 6.6 Add a `--self-improve` CLI flag to `agent.py` that enters the self-improvement loop (iterate through `tasks.json`) instead of running a single task

- [ ] 7.0 Deploy to Fly.io
  - [ ] 7.1 Write a `Dockerfile`: Python 3.11 slim base, install dependencies from `pyproject.toml`, copy source files, set entrypoint to `python agent.py`
  - [ ] 7.2 Write `fly.toml`: app name, region, machine size (shared-cpu-1x, 256MB RAM), persistent volume mount at `/data` for the git repo + knowledge files + cached docs, `auto_stop_machines = true`, environment variable references for `ANTHROPIC_API_KEY` and `FLY_API_TOKEN`
  - [ ] 7.3 Update `config.py` to detect the runtime environment (`AGENT_ENV`): when `prod`, use `/data` as the workspace root; when `dev`, use the local project directory
  - [ ] 7.4 Add a health-check endpoint or process: a minimal mechanism (e.g., a file touch or HTTP ping) that Fly.io can use to verify the machine is alive
  - [ ] 7.5 Write a session trigger script (`trigger.py` or CLI command): uses `flyctl machines run` or the Machines API to start an agent session with a given task, passing the task as an environment variable or argument
  - [ ] 7.6 Document deployment steps in a `DEPLOY.md`: `flyctl launch`, `flyctl volumes create`, `flyctl secrets set`, `flyctl deploy`, and how to trigger a session

- [ ] 8.0 Write tests and validate end-to-end behavior
  - [ ] 8.1 Write an integration test that runs the full agent loop with a mock LLM client and a local subprocess sandbox (no Fly.io), verifying: tool dispatch, conversation flow, step limits, and stop conditions
  - [ ] 8.2 Write an integration test for the git safety flow: agent modifies a file → auto-commit fires → agent modifies again with failing test → auto-revert triggers → workspace returns to last good state
  - [ ] 8.3 Write an integration test for the self-improvement cycle: seed a task in `tasks.json` → run the improvement loop → verify the task is marked complete, `AGENT.md` is updated, and a git commit exists for the change
  - [ ] 8.4 Write a test for rate-limit enforcement: simulate hitting the per-session self-modification limit and verify the agent is blocked from further modifications
  - [ ] 8.5 Write a test for constitution enforcement: attempt to modify a protected file and verify the operation is rejected
  - [ ] 8.6 Run `pytest tests/` and verify all tests pass. Fix any failures
  - [ ] 8.7 Manually run `python agent.py "list the files in the current directory"` against a real sandbox (Docker locally or Fly.io Sprite) and verify end-to-end behavior
