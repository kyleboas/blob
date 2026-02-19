# Tasks: Self-Modifying AI Agent v0.1

## Relevant Files

- `agent.py` - Core ReAct loop (think → act → observe → repeat).
- `sandbox.py` - Sandboxed command executor targeting Fly.io Sprites.
- `tools.py` - Tool definitions and JSON schemas for the LLM.
- `llm_client.py` - LLM provider abstraction layer (Anthropic adapter).
- `approval.py` - Human-in-the-loop approval gate (CLI stdin v0.1).
- `safety.py` - Git safety, rate limits, and constitution enforcement.
- `config.py` - Configuration constants and environment variable loading.
- `tasks.json` - Task queue for the self-improvement loop.
- `AGENT.md` - Persistent knowledge file updated each session.
- `docs/` - Cached documentation from allowlisted domains.
- `tests/` - Test suite for agent behavior validation.
- `Dockerfile` - Container image for Fly.io deployment.
- `fly.toml` - Fly.io app configuration.
- `pyproject.toml` - Project metadata and dependencies.

### Notes

- Unit tests should be placed in the `tests/` directory, mirroring the module they test (e.g., `tests/test_agent.py` for `agent.py`).
- Use `pytest` to run tests: `pytest tests/` for all, or `pytest tests/test_agent.py` for a specific module.
- The project uses Python with the `anthropic` SDK as the primary dependency.
- All commands the agent executes run inside a sandbox (Fly.io Sprite or Docker fallback). Never run agent-generated commands on the host.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/self-modifying-agent`)
- [ ] 1.0 Set up project skeleton and configuration
- [ ] 2.0 Implement the LLM provider abstraction layer
- [ ] 3.0 Build the sandboxed command executor
- [ ] 4.0 Implement the core agent ReAct loop
- [ ] 5.0 Add git-based safety, approval gates, and self-modification controls
- [ ] 6.0 Build the self-improvement loop and documentation ingestion
- [ ] 7.0 Deploy to Fly.io
- [ ] 8.0 Write tests and validate end-to-end behavior
