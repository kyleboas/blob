# Tasks: Pi-Method Full Autonomy

## Relevant Files

- `src/pi-agent.ts` - Core PiAgent class; tool registry, agent loop, and LLM call — primary file for tasks 1, 2, and 4
- `src/agent.ts` - Scheduled Agent class; `run()` and `commit()` stubs replaced in task 3
- `src/index.ts` - Worker entry point; scheduled handler updated in task 3
- `src/llm.ts` - LLM call layer; `callLLM()` updated to support structured tool call request/response in task 1
- `src/types.ts` - Shared TypeScript types; new ToolDefinition, ToolCall, and Message types added in task 1
- `src/slack.ts` - Slack handler; `handleSlackEvent()` updated to use PiAgent in task 3
- `src/do.ts` - Durable Object; updated to seed default self-targeting repo/goal in task 6
- `sandbox/Dockerfile` - Sandbox container; verify `gh` CLI or `curl` available for GitHub API calls in task 2
- `wrangler.agent.toml` - Reference config for building sanitized `wrangler.toml` in task 5
- `wrangler.toml` - Sanitized config to be created and committed (currently gitignored) in task 5
- `.gitignore` - Updated to stop ignoring `wrangler.toml` in task 5
- `.github/workflows/deploy.yml` - CI/CD deploy workflow created in task 5
- `CLAUDE.md` - Self-description file for agent; created in task 6

### Notes

- No test framework is currently configured. Verify correctness via end-to-end runs against the deployed Worker.
- The sandbox has outbound HTTP so GitHub REST API calls work from within tools.
- `GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` must be set as GitHub Actions secrets before CI/CD works — document this in `CLAUDE.md`.
- The existing `blob-git-askpass` credential helper in the Dockerfile already handles `GITHUB_TOKEN` auth for git clone/push.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, check it off by changing `- [ ]` to `- [x]`. Update after each sub-task, not just after completing a full parent task.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file`

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Confirm branch `claude/pi-autonomy-assessment-8H6Mo` is checked out and up to date with remote

- [ ] 1.0 Migrate PiAgent to structured JSON tool calls
  - [ ] 1.1 In `src/types.ts`, add TypeScript interfaces: `ToolSchema` (JSON Schema object), `ToolDefinition` (name, description, schema, handler), `ToolCall` (id, name, arguments), `ToolResult` (tool_call_id, content), and update `LLMMessage` to include `tool_calls` and `tool_call_id` fields
  - [ ] 1.2 In `src/pi-agent.ts`, update `ToolDefinition` to use the new `ToolSchema` interface and remove the `prompt` snippet field (no longer needed for system prompt injection)
  - [ ] 1.3 Rewrite all 7 existing tool definitions (`read`, `write`, `edit`, `bash`, `memory`, `extension`, `load`) with proper JSON Schema `parameters` blocks (type, properties, required, descriptions)
  - [ ] 1.4 In `src/llm.ts` (or `PiAgent.callLLM()`), update the AI Gateway request to include a `tools` array (serialized from registered `ToolDefinition`s) and `tool_choice: "auto"` in the request body
  - [ ] 1.5 In `PiAgent`, replace the text-format tool call parser (`TOOL: name\nARG: {...}`) with a parser that reads `response.choices[0].message.tool_calls[]` from the LLM response
  - [ ] 1.6 Update the agent loop so that when `tool_calls` is present the agent executes each call and appends a `tool` role message per result, then loops; when `tool_calls` is absent treat the text content as the final answer and stop
  - [ ] 1.7 Update the system prompt builder in `PiAgent` to remove the hand-written tool-format instructions (the LLM now uses JSON schema tool calling natively)
  - [ ] 1.8 Manually test via `POST /pi/chat` with a simple message to confirm tool calls round-trip correctly (bash echo, read a file)

- [ ] 2.0 Add git and github tools to PiAgent
  - [ ] 2.1 In `sandbox/Dockerfile`, verify `curl` and `jq` are installed (needed for GitHub REST API calls); add them if missing
  - [ ] 2.2 In `src/pi-agent.ts`, add a `git` tool with a single `command` string argument; the handler passes the full command to `execWithRetry()` prefixed with `git -C /workspace/<repo>`; valid subcommands: `clone`, `status`, `diff`, `add`, `commit`, `push`, `checkout`
  - [ ] 2.3 In `src/pi-agent.ts`, add a `github` tool with arguments `owner` (string), `repo` (string), `branch` (string), `title` (string), `body` (string), `draft` (boolean, default true); the handler calls the GitHub REST API (`POST /repos/{owner}/{repo}/pulls`) using `GITHUB_TOKEN` via `curl` in the sandbox
  - [ ] 2.4 Update the `PiAgent` system prompt to include the PR-first workflow rules: always work on a new branch named `blob/<unix-timestamp>-<kebab-goal-slug>`, never commit directly to `main`, always open a draft PR as the final step
  - [ ] 2.5 Manually test the `git` tool via `POST /pi/chat` with repo set: confirm clone, status, and a dummy commit+push to a test branch work end-to-end

- [ ] 3.0 Wire Agent.run() to PiAgent with clone-fresh-commit-PR flow
  - [ ] 3.1 In `src/agent.ts`, replace the `plan()` call and `commit()` stub with: instantiate `PiAgent`, register all tools (including `git` and `github`), then call `piAgent.run(systemPrompt, userPrompt)` where the user prompt is built from `repo` + `goals`
  - [ ] 3.2 In `src/agent.ts`, build a `runPrompt` that instructs the agent to: (1) clone the repo, (2) explore and find something actionable, (3) implement it, (4) commit to a new `blob/` branch, (5) open a draft PR — and return the PR URL as its final message
  - [ ] 3.3 In `src/agent.ts`, delete the `commit()` method entirely (git operations now happen via the `git` tool inside the PiAgent loop)
  - [ ] 3.4 In `src/index.ts`, confirm the scheduled handler still calls `new Agent(repo, goals, env).run()` — no changes needed if Agent API is preserved; update if signature changed
  - [ ] 3.5 In `src/slack.ts`, find the code path that delegates to `PiAgent` for repo analysis and confirm it now goes through the same `Agent.run()` flow, so Slack-triggered and cron-triggered runs are identical

- [ ] 4.0 Add grep, find, ls tools to PiAgent
  - [ ] 4.1 In `src/pi-agent.ts`, add a `grep` tool with arguments `pattern` (string), `path` (string, default `.`), `flags` (string, optional e.g. `-r`, `-n`, `-i`); handler runs `grep` in the sandbox respecting `.gitignore` via `git grep` when inside a repo
  - [ ] 4.2 In `src/pi-agent.ts`, add a `find` tool with arguments `path` (string), `pattern` (string glob); handler runs `find <path> -name "<pattern>"` in the sandbox, excluding `.git` and `node_modules`
  - [ ] 4.3 In `src/pi-agent.ts`, add an `ls` tool with arguments `path` (string, default `.`), `flags` (string, optional e.g. `-la`); handler runs `ls` in the sandbox
  - [ ] 4.4 Update the `PiAgent` system prompt to list `grep`, `find`, and `ls` as the preferred tools for exploration (over running bare `bash` find/grep commands)

- [ ] 5.0 Add CI/CD pipeline and commit sanitized wrangler.toml
  - [ ] 5.1 Create `.github/workflows/deploy.yml` that triggers on `push` to `main`; steps: checkout, `npm ci`, `wrangler deploy --env production` using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets
  - [ ] 5.2 Create a sanitized `wrangler.toml` by copying `wrangler.agent.toml`, removing any account IDs or secret values, and adding a comment header explaining that secrets are injected via environment variables or GitHub Actions secrets
  - [ ] 5.3 In `.gitignore`, change the `wrangler.toml` entry to `wrangler.*.local.toml` (or remove it entirely) so the sanitized `wrangler.toml` is tracked by git
  - [ ] 5.4 Verify `wrangler.toml` is now tracked by running `git status` and confirming it appears as a new file, then stage it

- [ ] 6.0 Register self-targeting goal and write CLAUDE.md
  - [ ] 6.1 In `src/do.ts`, in the Durable Object's initialisation logic (first-run or empty state check), seed `kyleboas/blob` as a default repo with the goal: `"Find TODOs, open issues, or incomplete features in this codebase. Pick one, implement it, and open a draft PR."`
  - [ ] 6.2 Ensure the seed only runs once (check if repos list is empty before seeding, so it doesn't overwrite user-configured repos on restart)
  - [ ] 6.3 Create `CLAUDE.md` at the repo root with the following sections: (1) Project purpose and architecture overview, (2) Directory structure with one-line descriptions, (3) How to build and deploy (`npm ci`, `wrangler deploy`), (4) Required environment variables and secrets, (5) Files the agent must not modify (e.g. `wrangler.agent.toml`, `sandbox/Dockerfile` unless fixing a specific issue), (6) The PR workflow the agent must follow (branch naming, draft PRs, never push to main), (7) Open questions from the PRD that remain unresolved
  - [ ] 6.4 Commit all changes from tasks 1–6 with a clear message and push to `claude/pi-autonomy-assessment-8H6Mo`
