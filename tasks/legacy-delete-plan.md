# Legacy Deletion Plan (Phase 1 Audit)

This plan identifies modules and config paths that should be removed or replaced during the sandbox refactor, based on current runtime wiring in `src/index.ts`, `src/slack.ts`, and `wrangler*.toml`.

## Keep (canonical runtime paths)

These are active entrypoints and should remain while refactoring:

- `src/index.ts`: Worker `fetch`/`scheduled` entrypoint.
- `src/do.ts`: current Durable Object backing state and event dedupe.
- `src/slack.ts`: Slack event handling and command dispatch.
- `src/sandbox.ts` + `src/sandbox-worker.ts`: sandbox execution path.
- `src/storage.ts`, `src/memory.ts`, `src/cron.ts`: DO-backed helpers.
- `src/llm.ts`, `src/models.ts`: model invocation and selection.

## Delete candidates

### 1) Duplicate/obsolete agent loops

1. `src/agent.ts`
   - **Why delete:** It defines a second autonomous loop (`Agent.run`) that only calls `plan()` and has a TODO commit step; it does not implement the Pi tool loop and overlaps with `PiAgent` responsibilities.
   - **Risk if kept:** Confusing dual orchestration paths and accidental invocation from `/run` and scheduled jobs.
   - **Migration:** Replace scheduled and `/run` usage with the DO job/heartbeat + Pi tool-loop implementation.

2. Legacy direct execution paths in `src/index.ts` (`/run` endpoint and `scheduled()` creating `new Agent(...)`)
   - **Why delete:** Bypasses DO job lifecycle and heartbeat model required by PRD.
   - **Risk if kept:** No pause/resume state, no deterministic per-thread routing, no budget enforcement.
   - **Migration:** Route all execution through DO-managed jobs keyed by Slack conversation key.

### 2) Workers-only pseudo-tool / template layers

3. `src/pi-routes.ts`
   - **Why delete:** Exposes standalone HTTP endpoints (`/pi/chat`, `/pi/simple`) that are not mounted in `src/index.ts` and bypass Slack→DO flow.
   - **Risk if kept:** Dead code and potential future bypass of policy and auditing controls.
   - **Migration:** Fold any needed behavior into the canonical Slack/DO runtime.

4. Slack command branches in `src/slack.ts` that call bespoke flows (`weather` curl, Codex login/run shortcuts)
   - **Why delete or refactor heavily:** They bypass the 4-tool canonical surface and create ad hoc capabilities outside the Pi tool loop.
   - **Risk if kept:** Tool-surface drift and inconsistent observability/cost controls.
   - **Migration:** Re-express as agent tasks through `read/write/edit/bash` only.

### 3) Unused/duplicative config and dependencies

5. `wrangler.toml.template`
   - **Why delete:** Duplicates active runtime config and includes bindings (`KV`, `Vectorize`) not represented in `Env` and not used by entrypoints.
   - **Risk if kept:** Deployment drift and misleading setup docs.
   - **Migration:** Keep one authoritative `wrangler` config per deploy target.

6. `wrangler.agent.toml` vs `wrangler.toml.template`
   - **Why consolidate:** Two agent configs with divergent bindings increase misconfiguration risk.
   - **Migration:** Canonicalize to a single checked-in config plus env-specific overrides only when required.

7. `@cloudflare/sandbox` import in `src/index.ts` (`Sandbox as SandboxDO`)
   - **Why delete import:** Not used in code path; type-only noise.
   - **Migration:** Remove import unless a concrete use is introduced.

### 4) Dead code and stale artifacts

8. `sandbox/restore-auth.py`
   - **Why review for deletion:** Operational script not referenced by Worker runtime; if no external runbook depends on it, remove.
   - **Migration:** Move any required operational steps into documented scripts under a single ops directory.

9. `docs/plan.md`
   - **Why replace:** Large exploratory document not aligned with canonical architecture/happy-path deliverable.
   - **Migration:** Supersede with `docs/architecture.md` and link PRD/tasks.

## Execution order

1. Remove or gate non-canonical runtime entrypoints (`/run`, `scheduled` direct agent loop, `pi-routes`).
2. Consolidate configuration (`wrangler` files) and clean unused bindings.
3. Remove duplicate orchestration modules (`src/agent.ts`) once DO job runner is active.
4. Prune helper scripts/docs after confirming no operational dependency.

## Validation checklist after deletions

- `src/index.ts` has only Slack ingress + deterministic DO routing + cron dispatch.
- No code path invokes an agent loop outside DO job lifecycle.
- Tool surface visible to model is only `read`, `write`, `edit`, `bash`.
- Wrangler config and `Env` bindings match one-to-one.
