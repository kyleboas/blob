# Tasks: Autonomous Heartbeat Loop for Continuous Self-Improvement

## Relevant Files

- `src/storage.ts` - Add helper to fetch the most recently used heartbeat channel.
- `src/storage.ts` - Extend heartbeat-history helpers needed for semantic dedup inputs (recent/completed tasks context).
- `src/storage.ts` - Persist operator feedback entries used to steer future autonomous planning cycles.
- `src/config.ts` - Add/adjust model-role configuration for planner vs sub-agent execution models.
- `src/agent.ts` - Add autonomous heartbeat generation, update scheduling behavior, and wire planner model selection vs smaller execution-model selection for sub-agents.
- `src/storage.test.ts` - Add/adjust tests for heartbeat channel lookup behavior (if storage unit tests exist here).
- `src/agent.test.ts` - Add/adjust unit tests for idle-queue generation and unconditional alarm re-scheduling.
- `src/llm.ts` - Regression validation reference for chat routing behavior (no implementation change expected).
- `src/index.ts` - Regression validation reference for prior mobile layout fix (no implementation change expected).
- `README.md` - Optional operator documentation update for autonomous channel behavior (if docs are maintained here).

### Notes

- Unit tests should typically be placed alongside the code files they are testing.
- Prefer deterministic tests by mocking time (`deps.now`) and LLM responses.
- For Durable Object alarm behavior, validate both “queue has item” and “queue empty” paths.
- Duplicate prevention should be validated semantically (planner judgment), not with regex-only matching rules.
- Steering feedback should be auditable in logs so operators can verify input changed subsequent autonomous planning.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/autonomous-heartbeat-loop`)
- [x] 1.0 Finalize technical design and acceptance criteria
  - [x] 1.1 Confirm intended autonomous behavior when queue is empty (generate, enqueue, re-schedule).
  - [x] 1.2 Confirm channel resolution order (`autonomous_channel` first, last-used channel fallback).
  - [x] 1.3 Confirm regression requirements for chat-routing behavior (chat always available; task detection still routes simple/complex) and existing rate-limit flow.
  - [x] 1.4 Confirm planner/executor model split (simple/complex plan; smaller sub-agents execute).
  - [x] 1.5 Confirm duplicate-prevention guardrails are planner-defined and cross-reference completed tasks (non-regex).
  - [x] 1.6 Confirm operator-feedback steering behavior and SLA for when feedback affects next tasks.
- [x] 2.0 Implement storage support for channel fallback
  - [x] 2.1 Add `getLastHeartbeatChannel(sql)` in `src/storage.ts`.
  - [x] 2.2 Ensure SQL query uses latest `updated_at` ordering and null-safe return.
  - [x] 2.3 Add/update unit tests for populated and empty heartbeat tables.
- [x] 3.0 Implement autonomous heartbeat generation in AgentDO
  - [x] 3.1 Update `src/agent.ts` imports to include `getSetting` and `getLastHeartbeatChannel`.
  - [x] 3.2 Add `generateAutonomousHeartbeat()` to resolve channel and skip when unavailable.
  - [x] 3.3 Build LLM call using chat-style prompt and no tools.
  - [x] 3.4 Parse response, ignore empty/`skip`, enqueue valid task, and emit global log event.
  - [x] 3.5 Add planner guardrail step to compare proposed task against recent/completed tasks and reject or rewrite duplicates before enqueue.
- [x] 4.0 Update heartbeat processing loop to be self-sustaining
  - [x] 4.1 Modify `processNextHeartbeat()` empty-queue path to call autonomous generation.
  - [x] 4.2 Remove conditional re-schedule gate and always schedule the next alarm.
  - [x] 4.3 Keep existing task execution path unchanged aside from unconditional scheduling.
- [x] 5.0 Add or update tests for autonomous loop behavior
  - [x] 5.1 Add test: empty queue with channel configured generates one task and schedules next alarm.
  - [x] 5.2 Add test: empty queue without channel skips generation but still schedules next alarm.
  - [x] 5.3 Add test: non-empty queue executes task and still schedules next alarm.
  - [x] 5.4 Add regression test/assertion that chat input like “Hello” remains chat-routed (no heartbeat enqueue).
  - [x] 5.5 Add/confirm regression assertion that detected tasks still route to simple/complex task models.
  - [x] 5.6 Add tests for duplicate prevention against completed tasks (exact and semantic near-duplicate cases).
  - [x] 5.7 Add tests proving deduplication does not depend on regex-only pattern checks.
- [ ] 6.0 Implement planner/executor model split for cost efficiency
  - [ ] 6.1 Add explicit config/settings for planner models (simple/complex) vs execution model(s) for sub-agents.
  - [ ] 6.2 Update orchestrator path so PRD/task planning uses planner models while sub-agents run smaller execution models.
  - [ ] 6.3 Ensure execution prompts enforce plan-following and tool-bounded execution behavior.
  - [ ] 6.4 Add tests that verify model selection differs between planning and execution phases.
  - [ ] 6.5 Ensure planner prompt/instructions explicitly include duplicate guardrail logic and historical cross-reference behavior.
- [ ] 7.0 Implement operator feedback steering for autonomous planning
  - [ ] 7.1 Add/extend endpoint or command handling so operator feedback can be submitted at any point during autonomous operation.
  - [ ] 7.2 Persist feedback in storage with timestamp and channel/session metadata for planner context retrieval.
  - [ ] 7.3 Include latest feedback context in planner input so subsequent autonomous tasks reflect operator steering.
  - [ ] 7.4 Emit logs/notifications confirming feedback receipt and when it is applied in planning.
  - [ ] 7.5 Add tests proving feedback changes subsequent autonomous task selection.
- [ ] 8.0 Validate behavior end-to-end and document operations
  - [ ] 8.1 Run automated tests and lint checks relevant to touched files.
  - [ ] 8.2 Verify log sequence in dev/staging: `heartbeat_start` → completion → autonomous `heartbeat_queued`.
  - [ ] 8.3 Verify planner/executor split in logs/telemetry (planning model vs execution model IDs).
  - [ ] 8.4 Verify duplicate-rate telemetry and sample logs confirm planner prevented repeated tasks.
  - [ ] 8.5 Verify steering-feedback telemetry shows input was received and influenced subsequent planning.
  - [ ] 8.6 Document bootstrap, channel configuration, planner/executor settings, dedup guardrails, and feedback steering behavior.
- [ ] 10.0 Add planner audit loop with bounded retries for sub-agent completion quality
  - [ ] 10.1 Add a post-execution planner audit step that verifies sub-agent output against task acceptance criteria and implementation expectations.
  - [ ] 10.2 If audit fails, require the planner to produce a targeted follow-up task for the sub-agent to close remaining implementation gaps.
  - [ ] 10.3 Continue audit → follow-up execution cycles until the planner marks the task fully implemented or a retry limit is reached; do not close the task as merely incomplete without diagnosis and a remediation decision.
  - [ ] 10.4 Add an explicit max-audit-attempt setting/constant and fail-safe terminal state to prevent infinite loops.
  - [ ] 10.5 Require planner failure analysis on each failed audit attempt (root cause + missing acceptance criteria mapping); the planner cannot simply mark the task incomplete or let it drop without a diagnosed disposition.
  - [ ] 10.6 Emit logs/telemetry for each audit attempt, including pass/fail reason, diagnosis details, follow-up scope, and termination reason.
  - [ ] 10.7 Add tests covering: immediate audit pass, pass-after-retry, diagnosis-generated follow-up quality, and stop-on-max-attempt behavior.
