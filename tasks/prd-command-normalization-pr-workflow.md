## 1. Introduction/Overview

Blob sometimes appears “stuck” during production runs because it executes long, monolithic shell command chains (e.g., `... && git push ... && ...`) and only logs at the start/end of the tool call. This hides progress and failures until the command returns or times out.

Blob also frequently fails GitHub PR workflows by:
- using `gh pr create` (not installed in the sandbox),
- reusing fixed branch names (collisions across runs),
- attempting to push the default branch (e.g., `git push origin main`) instead of opening a PR,
- running non-idempotent git commands (e.g., `git checkout -b` when branch already exists),
- relying on interactive auth prompts (blocked in sandbox).

This feature adds a repo-agnostic execution layer that:
1) prevents “stuck” runs by splitting composite commands into step-by-step execution with per-step logs, and  
2) enforces a safe, reliable GitHub PR workflow by rewriting unsafe operations (including auto-rewriting default-branch pushes into PR workflows).

## 2. Goals (specific + measurable)

1) Reduce “stuck” incidents:
- The system must log progress per-step for composite commands.
- Median time-to-first-action log for PR workflows should be < 2 seconds after tool start (excluding cold start).

2) Enforce safe PR workflow:
- Default-branch pushes (main/master/default) should never be executed directly; they must be rewritten into a branch + PR workflow.
- `gh` usage must be blocked or rewritten.

3) Improve reliability:
- PR workflow should succeed in production when valid GitHub credentials exist (no interactive prompts).
- The agent should not fail due to local branch collisions (use idempotent git operations).

4) Improve operator clarity:
- Logs must distinguish between `command_proposed` vs `command_executed` vs `command_blocked/rewrite`.

## 3. User Stories

1) As an operator, when Blob runs a multi-step command, I want to see each step logged so I can tell it’s working and where it fails.

2) As an operator, I want Blob to open PRs reliably without pushing to main or requiring manual `.netrc` hacks.

3) As a maintainer, I want the PR flow to work across different repos (not hardcoded to `blob`) and be safe by default.

4) As a maintainer, I want a `/diag` endpoint that can validate production readiness (Slack ingress, DO, LLM, sandbox, GitHub auth) without creating PRs.

## 4. Functional Requirements

1) Composite command execution (anti-stuck)
1.1 The system must detect composite shell commands that contain `&&` and execute them step-by-step instead of as a single monolithic tool run (within defined scope).
1.2 The system must log each step as:
- `command_proposed` (before safety/rewrites),
- `command_executed` (only when actually executed),
- `command_rewritten` (when rewritten),
- `command_blocked` (when blocked).
1.3 The system must stop execution on the first failing step and return a clear error message including the failing step.

2) PR workflow enforcement (repo-agnostic)
2.1 The system must prevent direct pushes to the repo’s default branch (e.g., `main`, `master`, or resolved default branch) and must auto-rewrite them into a PR workflow:
- ensure clean base branch checkout,
- create unique branch name,
- commit changes,
- push branch,
- create PR.
2.2 The system must ensure branch creation is idempotent (e.g., rewrite `git checkout -b X` → `git checkout -B X`).
2.3 The system must reject or rewrite attempts to use `gh` (GitHub CLI) for PR creation.

3) Reliable PR creation method (secure + robust)
3.1 The system must prefer using a repo-local helper when available:
- `python github_tools.py push ...`
- `python github_tools.py create-pr ...`
3.2 If repo-local helpers are not present, the system must fall back to direct GitHub API calls from the Worker (not from sandbox) for PR creation, using `GITHUB_TOKEN` from Worker secrets.
3.3 The system must never require writing credentials to `~/.netrc` and must treat `.netrc` modification attempts as blocked.
3.4 The system must never echo tokens into logs. Any command output containing known secrets must be sanitized before logging.

4) Repo context inference (repo-agnostic)
4.1 The system must infer `{owner, repo}` from git remote URLs (HTTPS or SSH) for use in PR creation.
4.2 The system must track repo context per working directory during a composite command session.

5) Canary/diagnostics (read-only)
5.1 The system must expose a token-protected `/diag/run` endpoint that runs a production smoke test:
- Worker health,
- DO fetch/logging path,
- LLM minimal call (cheap),
- sandbox exec minimal command (e.g., `echo ok`),
- GitHub auth check (e.g., “whoami” via GitHub API).
5.2 The `/diag/run` endpoint must not create branches or PRs (read-only verification only).

## 5. Non-Goals (Out of Scope)

- Building a full POSIX shell parser that perfectly handles all quoting/escaping edge cases.
- Automatically resolving GitHub branch protection rules or bypassing required reviews.
- Guaranteeing PR creation on repos where the token lacks permissions.
- Installing the GitHub CLI (`gh`) in the sandbox (we will avoid it).

## 6. Design Considerations (optional)

- Command splitting should be conservative:
  - Primary target: PR workflows and git-heavy command chains.
  - Only split on top-level `&&` in the simplest form; avoid splitting inside quotes where feasible.
- Prefer deterministic, idempotent git operations:
  - `checkout -B`, explicit base checkout, unique branch names.
- Keep token handling out of shell where possible:
  - Prefer Worker-side GitHub API calls for PR creation.
  - Prefer repo helper scripts that do not print tokens.

## 7. Technical Considerations (optional)

- Implement composite execution and rewrite logic in the Durable Object (execution path) before calling `sandbox.exec`.
- Store ephemeral rewrite context (cwd, repo mapping, branch name) in-memory for the single tool run; do not persist secrets.
- Extend tests in `src/agent.test.ts` to validate:
  - splitting behavior,
  - rewrite rules,
  - blocked `.netrc` and default-branch pushes,
  - no “stuck” behavior (per-step logging),
  - PR workflow chooses reliable method.

## 8. Success Metrics

- 0 occurrences of direct `git push origin main/master` being executed in production logs (should be blocked or rewritten).
- Composite commands produce per-step logs 100% of the time within the defined scope.
- `/diag/run` returns `ok: true` when production is properly configured, and returns actionable failures otherwise.
- Reduction in “Paused pending approval” loops caused by `rm -rf` or `.netrc` patterns in PR workflows.

## 9. Open Questions

1) Should command splitting apply only when git/PR patterns are detected, or for all `&&` commands above a length threshold?
2) What is the authoritative “default branch” resolution strategy when repo context is known (GitHub API vs `origin/HEAD`)?
3) Should we add a configuration flag to disable auto-rewrites for users who want strict blocking only?
4) Should `/diag/run` include Slack ingress verification, or remain HTTP-only?