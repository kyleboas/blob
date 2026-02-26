## Relevant Files

- `src/agent.ts` - Core execution loop; add composite command splitting, rewrite/block logic, repo context inference, and improved logging (`command_proposed` vs `command_executed`).
- `src/safety.ts` - Enforce/centralize safety rules for `.netrc` writes, default-branch pushes, and other risky git patterns (block or rewrite triggers).
- `src/index.ts` - Add `/diag/run` HTTP route and authentication; optionally add a lightweight diag runner entrypoint.
- `src/llm.ts` - (Optional) Improve resilience/clarity around tool-mode errors so failures aren’t perceived as “stuck”.
- `src/sandbox-client.ts` - Ensure timeouts/errors are surfaced clearly per-step; confirm command validation constraints (e.g., blocks `$(`) are respected by rewrites.
- `src/storage.ts` - (Optional) Store/read diag settings (e.g., diag channel, tokens) or model settings if needed.
- `src/agent.test.ts` - Unit tests for splitting, rewrite rules, logging semantics, and safe PR workflow enforcement.
- `src/integration-flow.test.ts` - Integration coverage for end-to-end diag flow and routing behaviors.
- `sandbox/Dockerfile` - (Optional) If you choose to bake tooling into the sandbox image; must not depend on `gh`.
- `README.md` - Document PR workflow rules, required secrets, and `/diag/run` usage.
- `docs/` (e.g., `docs/SETUP.md`) - Deployment/setup instructions for other users’ Cloudflare dashboards.

### Notes

- Avoid implementing a full shell parser. Prefer conservative splitting: split only on top-level `&&` in simple commands and/or in PR workflows.
- Sandbox command validation blocks command substitution (`$(`) and backticks. Rewrites must not introduce these.
- Do not rely on `gh` (GitHub CLI). Prefer repo helper when available, otherwise Worker-side GitHub API.
- Never log secrets. Ensure `GITHUB_TOKEN` is sanitized from all logs.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/command-normalization-pr-workflow`)

- [ ] 1.0 Define and implement composite command splitting (anti-stuck)
  - [ ] 1.1 In `src/agent.ts`, add a “composite command detector” that identifies commands containing `&&` within the supported scope (start conservative).
  - [ ] 1.2 Implement a safe splitter that produces an ordered list of steps (avoid splitting inside obvious quoted segments; if uncertain, do not split).
  - [ ] 1.3 Add an execution harness that runs each step sequentially with per-step logging and stops on first failure.
  - [ ] 1.4 Ensure the harness tracks a “current working directory” (`cd ...`) across steps without requiring `$()` substitution.
  - [ ] 1.5 Ensure each step uses the existing timeout policy and returns partial progress + failing step in the final error summary.
  - [ ] 1.6 Update log event types so operators can clearly see:
    - `command_proposed` (before safety/rewrite)
    - `command_rewritten` (when rewritten)
    - `command_executed` (only if actually executed)
    - `command_blocked` / `command_needs_approval` (when blocked)
  - [ ] 1.7 Add a regression test to ensure composite commands no longer appear “stuck” by validating multiple `command_executed` logs appear per run.

- [ ] 2.0 Implement repo-agnostic PR workflow enforcement and rewrites (no push default branch, no gh, idempotent git)
  - [ ] 2.1 Add rewrite rules to make git operations idempotent:
    - rewrite `git checkout -b <branch>` → `git checkout -B <branch>`
    - avoid fixed branch names in “test PR” flows (generate unique names without `$()`; e.g., `$RANDOM`).
  - [ ] 2.2 Block or rewrite attempts to use `gh`:
    - If `gh` appears in a command, rewrite to the supported PR creation path (see Task 3), or block with guidance.
  - [ ] 2.3 Block attempts to write/modify `~/.netrc` (and similar credential files) at the safety layer.
  - [ ] 2.4 Implement detection for “push default branch” patterns:
    - `git push origin main|master` (and other default branch names when known)
    - Rewrite these into PR workflow steps (create branch → push branch → open PR) rather than executing.
  - [ ] 2.5 Ensure base branch is checked out deterministically before branching:
    - Prefer explicit `main` if repo default cannot be inferred safely without `$()`.
    - If repo context is known, optionally resolve default branch via GitHub API (Worker-side) rather than shell tricks.
  - [ ] 2.6 Ensure rewrites do not introduce disallowed patterns from `src/sandbox-client.ts` validation (`$(`, backticks, etc.).
  - [ ] 2.7 Add tests covering:
    - `git push origin main` is never executed directly (blocked or rewritten)
    - `gh pr create` is blocked or rewritten
    - `.netrc` writes are blocked
    - branch collisions do not fail runs (`checkout -B` behavior)

- [ ] 3.0 Implement reliable PR creation path (prefer repo helper; fallback to Worker-side GitHub API)
  - [ ] 3.1 Detect whether repo-local helper exists in the working tree:
    - `github_tools.py` present and runnable with current python.
  - [ ] 3.2 Implement a “push branch” path that prefers:
    - `python github_tools.py push --owner <o> --repo <r> --branch <b>`
    - Falls back to `git push origin <b>` only if safe and non-interactive auth is confirmed (do not rely on prompts).
  - [ ] 3.3 Implement PR creation that prefers:
    - `python github_tools.py create-pr ...`
  - [ ] 3.4 Implement Worker-side GitHub API fallback (secure + most reliable):
    - In `src/index.ts` or a new TS module, add a minimal GitHub client using `fetch` and `Authorization: Bearer ${GITHUB_TOKEN}`
    - Create PR via `POST /repos/{owner}/{repo}/pulls`
    - Resolve default branch via `GET /repos/{owner}/{repo}` when needed
  - [ ] 3.5 Ensure PR creation fallback never logs tokens; sanitize error bodies before logging.
  - [ ] 3.6 Implement repo context inference:
    - Track `{owner, repo}` from clone URL and/or `git remote -v` (avoid command substitution).
    - Carry repo context through composite execution steps.
  - [ ] 3.7 Add unit tests with mocked `fetch` for Worker-side PR creation fallback:
    - success path returns PR URL/number
    - missing token returns a clear actionable error
    - permission error returns sanitized message

- [ ] 4.0 Add token-protected `/diag/run` read-only production canary
  - [ ] 4.1 Add `/diag/run` route in `src/index.ts`.
  - [ ] 4.2 Implement authentication for `/diag/run`:
    - Require `Authorization: Bearer <token>` and compare to `DIAG_TOKEN` (new Worker secret).
  - [ ] 4.3 Implement diag checks (read-only, no PRs, no pushes):
    - Worker health (internal)
    - DO round-trip (e.g., `log_event` or `logs_snapshot` with a trace_id)
    - LLM minimal call (cheap, small max_tokens)
    - Sandbox exec minimal command (`echo ok`)
    - GitHub auth check via GitHub API `GET /user` using `GITHUB_TOKEN`
  - [ ] 4.4 Return a structured JSON response:
    - `trace_id`, `ok`, per-check `{name, ok, ms, error?}`
  - [ ] 4.5 Add tests for `/diag/run`:
    - unauthorized returns 401/403
    - authorized returns expected JSON structure
    - failure cases return `ok:false` with per-check error
  - [ ] 4.6 Document required secrets and a sample curl command in `README.md`.

- [ ] 5.0 Add/Update tests and documentation
  - [ ] 5.1 Update `src/agent.test.ts` expectations impacted by:
    - new logging semantics (`command_proposed` vs `command_executed`)
    - composite execution sequencing (multiple exec calls per composite command)
  - [ ] 5.2 Add new focused unit tests for:
    - “split and execute” behavior
    - rewrite correctness without disallowed shell patterns
    - PR workflow enforcement (no push default branch, no gh)
  - [ ] 5.3 Add/adjust integration tests in `src/integration-flow.test.ts` to validate:
    - diag route can run in the worker test pool (mock external calls)
    - command rewrite path is triggered in a representative flow
  - [ ] 5.4 Update `README.md`/`docs/SETUP.md` with:
    - PR workflow rules Blob follows
    - required secrets (`GITHUB_TOKEN`, `GITHUB_USERNAME`, `DIAG_TOKEN`, Slack tokens if used)
    - deploying sandbox + main worker in Cloudflare
    - how to run `/diag/run` and interpret results