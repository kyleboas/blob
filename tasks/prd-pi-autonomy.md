# PRD: Pi-Method Full Autonomy

## 1. Introduction / Overview

`blob` is an AI coding agent deployed on Cloudflare Workers. It can already receive goals via Slack or API, run an agentic tool loop in a sandboxed Docker container, and manage repo/goal state in a Durable Object. However, it cannot currently complete the full autonomous loop: find something to do → implement it → commit → open a PR → trigger deployment.

This PRD describes the work required to close that gap and make `blob` fully autonomous using the Pi method — meaning it can improve itself and other repos end-to-end without human intervention beyond PR review and merge.

---

## 2. Goals

1. The scheduled agent (`Agent.run()`) must invoke the full `PiAgent` tool loop rather than the current stub `plan()` → `commit()` flow.
2. The agent must be able to clone a git repo, make file changes, commit, and open a GitHub PR — all within a single sandbox session.
3. Merging a PR to `main` must automatically deploy the updated Worker via Cloudflare's native GitHub integration (no GitHub Actions workflow required).
4. `PiAgent` must use OpenAI-compatible structured JSON tool calls (not text-format parsing) for all 7 core Pi tools plus git/GitHub tools.
5. `blob` itself must be registered as a default self-improvement target in the Durable Object.
6. A `CLAUDE.md` file must exist in the repo to guide the agent when it works on itself.

---

## 3. User Stories

- **As the repo owner**, I want `blob` to find TODOs or open issues in its own codebase, implement fixes, and open a PR — without me writing any code — so I can review and merge at my convenience.
- **As the repo owner**, I want merging a PR to `main` to automatically deploy the updated Worker to Cloudflare — so there is no manual deploy step.
- **As the repo owner**, I want to add any GitHub repo and a natural-language goal via Slack, and have `blob` autonomously work toward that goal on a schedule.
- **As the repo owner**, I want the agent's tool calls to be structured and reliable, so it doesn't fail due to text-parsing edge cases.

---

## 4. Functional Requirements

### 4.1 Agent Loop Wiring
1. The system must call `PiAgent.run()` from `Agent.run()` instead of the current `plan()` stub.
2. The system must pass the repo name, goals, sandbox bindings, and environment into `PiAgent` on each scheduled run.
3. The system must support both Slack-triggered and cron-triggered runs using the same `PiAgent` code path.

### 4.2 Git Operations (Sandbox)
4. The system must clone the target GitHub repo into `/workspace/<repo>` at the start of each agent run using the existing `GITHUB_TOKEN` credential helper.
5. The system must provide a `git` tool in `PiAgent` that supports: `clone`, `status`, `diff`, `add`, `commit`, `push`, `checkout -b`.
6. The system must provide a `github` tool in `PiAgent` that can open a pull request via the GitHub REST API, given a branch name, title, and body.
7. The system must commit with a descriptive message and push to a new branch named `blob/<timestamp>-<slug>` before the sandbox session ends.
8. The system must open a draft PR from that branch targeting `main`, with a summary of changes in the PR body.
9. The system must NOT push directly to `main`.

### 4.3 Deploy Configuration
10. A sanitized `wrangler.toml` (with no secrets, only structure) must be committed to the repo so Cloudflare's native GitHub integration can use it to build and deploy on merge to `main`.
11. The `.gitignore` entry for `wrangler.toml` must be removed or scoped so the sanitized config is tracked by git.

### 4.4 Structured Tool Calls
13. The system must use OpenAI-compatible JSON schema tool definitions for all `PiAgent` tools (replacing the current `TOOL: name\nARG: {...}` text-format parsing).
14. The system must define JSON schemas for these tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `git`, `github`, `memory`.
15. The system must parse tool calls from the LLM's `tool_calls` response field, not from message text content.
16. The system must fall back gracefully if the LLM returns no tool calls and provides a text-only response (treat as final answer).

### 4.5 Self-Targeting
17. The system must register `kyleboas/blob` as a default repo in the Durable Object on first initialisation, with the goal: `"Find TODOs, open issues, or incomplete features in this codebase. Pick one, implement it, and open a PR."`.
18. The system must allow additional repos and goals to be added via the existing `POST /repos` and `POST /repos/:repo/goals` API endpoints.
19. The system must allow repos and goals to be set via Slack natural-language commands (existing intent classification).

### 4.6 CLAUDE.md
20. The repo must contain a `CLAUDE.md` file at the root that describes: project purpose, directory structure, how to build/deploy, how to run the agent locally, what files the agent should and should not modify, and the PR workflow the agent must follow.

---

## 5. Non-Goals (Out of Scope)

- Auto-merging PRs — human review and merge is always required.
- Multi-step multi-session tasks (each cron run is a single self-contained session).
- R2-based workspace caching — the agent clones fresh on every run.
- Vectorize-based workspace persistence.
- Support for non-GitHub git hosts (GitLab, Bitbucket).
- Running `wrangler deploy` directly from the sandbox.
- Any UI beyond existing Slack and HTTP API.

---

## 6. Design Considerations

### Stateless sandbox runs
Each cron invocation must be fully self-contained:
1. Sandbox starts → repo is cloned → `PiAgent` runs its tool loop → changes are committed and pushed to a branch → PR is opened → sandbox exits.

If any step fails, the run ends with an error logged to the Durable Object. No partial state is carried forward.

### Branch naming
Branch names follow the pattern `blob/<unix-timestamp>-<kebab-slug-of-goal>` to avoid collisions across runs.

### PR body
The `github` tool must populate the PR body with: the goal that was being pursued, a bullet list of files changed, and a brief description of what was done (generated by the LLM at the end of the tool loop).

---

## 7. Technical Considerations

- **Structured tool calls**: The AI Gateway / Workers AI binding must support `tools` + `tool_choice` in the request payload. Verify this against the Cloudflare AI Gateway OpenAI-compatibility docs before implementation.
- **`wrangler.toml` in git**: Currently gitignored. A sanitized version (no account IDs, no secrets — Cloudflare's dashboard integration supplies those) must be created and committed. The `.gitignore` entry must be updated or made more specific.
- **GitHub API calls from sandbox**: The sandbox container has outbound HTTP access. The `github` tool makes REST calls to `https://api.github.com` using `GITHUB_TOKEN`.
- **`GITHUB_TOKEN` scope**: Must have `repo` and `pull_request` scopes to push branches and open PRs.
- **`PiAgent` system prompt update**: Must include instructions for the git/github tools and the PR-first workflow (never push to main, always open a PR).

---

## 8. Success Metrics

1. A cron-triggered run on `kyleboas/blob` produces a committed branch and an open GitHub PR — with zero human input.
2. Merging that PR to `main` triggers Cloudflare's native GitHub integration and the updated Worker is live within 5 minutes.
3. All 10 tool types (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `git`, `github`, `memory`) execute via structured JSON tool calls with no text-parsing fallback needed in normal operation.
4. Zero `TODO` comments remain in `agent.ts` after implementation.
5. A Slack message like "work on kyleboas/blob" triggers the same full-autonomy loop as the cron job.

---

## 9. Open Questions

1. Does the Cloudflare AI Gateway support `tools` + `tool_choice` for all configured model providers, or only OpenAI-compatible ones? If not, Workers AI (Llama) may need a different tool-call strategy.
2. Should the `github` tool also support reading open issues (so the agent can pick an issue to work on, not just TODOs in code)?
3. What is the max acceptable sandbox run time per cron invocation before it should time out and clean up?
4. Should failed runs post a notification to Slack automatically?
