# PRD: Autonomous Heartbeat Loop for Continuous Self-Improvement

## 1. Introduction / Overview
Blob currently runs heartbeat tasks from a Durable Object queue (`blob:heartbeats`). It processes queued tasks on each alarm cycle, but when the queue becomes empty, the alarm is not re-scheduled. This causes Blob to go idle and stop improving until a human enqueues another task.

This feature makes Blob continuously active. When the queue is empty, Blob should generate one self-improvement task, enqueue it, and keep the alarm loop alive so the next cycle executes it.

## 2. Goals
- Keep the heartbeat loop running continuously once started, even when the queue drains.
- Automatically generate one actionable self-improvement task when there is no pending work.
- Route autonomous heartbeat updates to a valid Slack channel using deterministic fallback logic.
- Preserve user chat access at all times, with routing that keeps chat on the chat model and sends detected tasks to simple/complex task models.
- Preserve existing behavior for manually queued heartbeats and existing chat/task classification improvements.
- Reduce cost by using simple/complex models for planning (PRD/tasks) and smaller sub-agent models for execution of approved plans.
- Validate the behavior through logs and regression checks.
- Prevent duplicate or near-duplicate autonomous tasks by using planner-defined semantic guardrails that cross-reference past completed tasks (not regex matching).
- Allow operator feedback at any point so humans can steer, reprioritize, or stop autonomous work in real time.

## 3. User Stories
- As a maintainer, I want Blob to continue running in the background without prompting so it can improve itself 24/7.
- As an operator, I want autonomous output to appear in the right Slack channel so I can monitor what Blob is doing.
- As a developer, I want the queue/alarm behavior to be deterministic so Blob never silently stops after completing work.
- As a user, I want to chat with Blob at any time without interrupting autonomous heartbeat work.
- As a user, I want normal chat messages to stay chat-only, while real tasks are routed to simple/complex task models.
- As an operator, I want planning and execution models separated so high-cost reasoning is used only for planning and lower-cost models execute tool steps.
- As an operator, I want autonomous planning to avoid repeating already-completed work by checking historical tasks semantically before enqueueing.
- As an operator, I want to provide feedback at any point during autonomous operation so Blob can adjust what it works on next.

## 4. Functional Requirements
1. The system must add a storage helper that returns the most recently used heartbeat channel from the `heartbeats` table.
2. The system must add an autonomous task generation method in `AgentDO` that:
   - Resolves channel in this order: `autonomous_channel` setting, then last-used heartbeat channel.
   - Skips generation when no channel exists.
   - Calls the chat model with a lightweight prompt requesting exactly one self-improvement task.
   - Ignores empty or `skip` responses.
   - Enqueues valid generated tasks and emits a global log entry.
3. The system must update heartbeat processing so that when the queue is empty it attempts autonomous generation and still schedules the next alarm.
4. The system must always schedule the next alarm after each heartbeat cycle, regardless of queue state.
5. The system must preserve current task execution logic (`runAgentLoop` with self-modification rate limits) for generated and manual tasks.
6. The system must preserve existing chat-routing behavior so chat-only messages remain on the chat model and are not turned into heartbeat tasks.
7. The system must preserve router behavior so detected tasks are still assigned to simple or complex task models.
8. The system must use simple/complex models as planning models for creating PRDs/task plans, while sub-agent execution runs on smaller execution-focused models that follow the plan and use defined tools.
9. The system must implement duplicate-prevention guardrails defined by the planner model, using semantic comparison against recent and completed heartbeat tasks before enqueueing autonomous work.
10. The system must not rely on regex-only duplicate detection for autonomous task deduplication decisions.
11. The system must proactively post periodic progress updates to the operator channel while running unprompted tasks.
12. The system must accept operator feedback at any point (e.g., Slack message/command), incorporate it into planning context, and steer subsequent autonomous tasks accordingly.
13. The system must continue to allow bootstrapping by one initial manual heartbeat that starts the recurring alarm loop.

## 5. Non-Goals (Out of Scope)
- Changing self-modification rate limit values or policy.
- Building a new scheduling frequency control UI.
- Implementing multi-task autonomous planning per cycle.
- Modifying Slack app architecture beyond channel selection for autonomous tasks.
- Reworking the chat/task classifier beyond regression verification.
- Replacing the PRD/tasks artifact format itself; this change is model-role assignment and orchestration behavior.

## 6. Design Considerations
- Keep autonomous generation lightweight (chat-only call, no tools) to minimize cost.
- Prefer explicit operator configuration (`autonomous_channel`) while supporting no-config fallback (`last-used channel`).
- Use clear, structured log events so operators can verify lifecycle: start → complete → auto-queued.
- Keep expensive reasoning in planner models; execution agents should prioritize deterministic tool use, bounded context, and low token usage.
- Deduplication quality should be semantic and planner-judged (task intent/scope), not string-pattern heuristics.
- Feedback handling should be low-latency and visible, so operators can confirm steering input was received and applied.

## 7. Technical Considerations
- Add `getLastHeartbeatChannel(sql)` in `src/storage.ts` using `updated_at DESC LIMIT 1`.
- Update `src/agent.ts` imports to include `getSetting` and `getLastHeartbeatChannel` from storage helpers.
- Add `generateAutonomousHeartbeat()` method in `AgentDO` to build context from existing summaries/knowledge and call `llmCall` via `buildLlmInput`.
- Update `processNextHeartbeat()` to:
  - branch on empty queue,
  - call autonomous generation when idle,
  - always `setAlarm(now + BACKGROUND_TASK_INTERVAL_MS)`.
- Ensure existing path for queued tasks remains unchanged except for unconditional alarm scheduling.
- Introduce explicit model-role mapping in orchestration settings/config: planner models (`simple`/`complex`) vs execution model(s) for sub-agents.
- Add a planner-side guardrail step that receives recent pending/completed heartbeat history and rejects or rewrites duplicate/near-duplicate proposed tasks before enqueue.
- Add a feedback-ingestion path that persists operator steering input and includes it in planner context for subsequent autonomous task generation cycles.

## 8. Success Metrics
- After one manual heartbeat bootstrap, no idle stop occurs while the service is healthy.
- Logs show recurring alarm cycles even when queue empties.
- Within two idle intervals, logs include at least one `heartbeat_queued` event with an autonomous description (unless generator returns `skip`).
- Generated heartbeats are executed in subsequent cycles (`heartbeat_start` observed after auto-queue).
- Regression check confirms chat input like “Hello” does not trigger task enqueue behavior.
- Cost metrics show lower average tokens/$ per completed autonomous task after planner/executor split.
- Duplicate autonomous tasks per day are reduced to an agreed threshold (e.g., near-zero exact duplicates; materially fewer semantic repeats).
- Operator feedback is reflected in subsequent autonomous task choices within a target SLA (e.g., next cycle).

## 9. Open Questions
- Should autonomous generation be disabled by a setting for cost-sensitive deployments?
- Should we add guardrails to avoid repeatedly generating near-duplicate tasks?
- Should we emit a dedicated metric for autonomous `skip` responses to help monitor idling quality?
- Should the interval remain fixed at 5 minutes or become configurable per deployment?
- How far back should semantic deduplication look (last N tasks, last N days, or all completed tasks)?
- What feedback interface should be canonical for steering (freeform Slack, explicit commands, or both)?
