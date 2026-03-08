# PRD: Blob Orchestrator + Security Hardening

## 1. Introduction/Overview

Blob currently works best as a repository-focused coding agent. It can bootstrap a repository, read and edit files, run shell commands, and verify changes. However, the product goal is broader: Blob should also act as a personal assistant and orchestrator while remaining safe enough to recommend to other users.

This feature introduces a two-layer architecture for Blob. The first layer is an assistant/orchestrator that handles general-purpose assistant behavior such as routing, memory, reminders, task orchestration, and deciding what kind of work is being requested. The second layer is a repo executor that performs higher-trust code and shell work inside a hardened execution boundary.

The same milestone also hardens Blob's current security model. This includes true per-job or per-conversation sandbox isolation, explicit capability gating for high-risk tools, stronger credential and secret handling, and better cleanup and audit controls. The release should remain Cloudflare-first, but the design should not block future portability.

The intended outcome is a Blob that can safely switch between assistant mode and repo-executor mode, orchestrate personal-assistant tasks, and modify its own repository with verification when explicitly routed into that higher-trust path.

## 2. Goals (specific + measurable)

1. Introduce a clear assistant/orchestrator layer that can classify and route at least four request types: assistant chat, reminders/tasks, research/orchestration, and repo execution.
2. Replace shared execution behavior with true per-job or per-conversation sandbox isolation for all repo-executor runs.
3. Add explicit capability elevation so repo modification, shell access, and secret use are not available by default in low-trust assistant flows.
4. Harden secret and credential handling so long-lived credentials are not written into global configuration or unnecessarily exposed to the execution environment.
5. Add cleanup, audit, and logging safeguards so execution residue is minimized and sensitive output is redacted before persistence or display.
6. Support end-to-end flows where Blob can act as an assistant, orchestrate a task, and safely modify its own repository with verification.
7. Keep the implementation Cloudflare-first while defining interfaces that would allow future execution backends without major rewrites.

## 3. User Stories

- As a user, I want Blob to answer normal assistant requests without automatically getting permission to edit code or run shell commands.
- As a user, I want Blob to recognize when a request should become a repo task and route it into a higher-trust executor.
- As a user, I want Blob to remember useful context, manage reminders or tasks, and orchestrate multi-step work.
- As a user, I want Blob to safely improve its own codebase when asked, including verification before it reports success.
- As a user, I want dangerous capabilities such as bash, repository writes, and secret-backed operations to be clearly controlled.
- As an operator, I want each execution run to have isolated sandbox state so one task cannot contaminate another.
- As an operator, I want logs and stored artifacts to avoid leaking secrets or unnecessary execution residue.
- As a future maintainer, I want a clean separation between orchestration logic and execution logic so the system is easier to extend.

## 4. Functional Requirements

1. The system must provide an assistant/orchestrator layer that receives user requests before any repo-executor logic runs.
2. The system must classify incoming requests into at least these categories: assistant conversation, reminder/task management, research/orchestration, and repo execution.
3. The system must keep low-trust assistant flows separate from high-trust repo-executor flows.
4. The system must require explicit capability elevation before enabling repository writes, shell execution, or access to sensitive credentials.
5. The system must expose a routing decision for each request so the system can explain internally which execution path was chosen.
6. The system must support reminders, memory updates, and task orchestration in assistant mode without requiring repository bootstrap.
7. The system must preserve Blob's existing ability to bootstrap a repository workspace and operate on it when routed into repo-executor mode.
8. The system must run repo-executor work in a truly isolated sandbox per job or per conversation, instead of relying on shared underlying execution state.
9. The system must make sandbox identity a first-class input across worker methods, session management, persistence, and cleanup paths.
10. The system must limit shell access through policy-based capability gating rather than a minimal denylist alone.
11. The system must define safe default shell policies for normal repo work and stricter elevated policies for higher-risk commands.
12. The system must prevent low-trust assistant requests from automatically inheriting repo-executor tools.
13. The system must harden repository bootstrap so credentials are short-lived, least-privilege, and not written into persistent global configuration.
14. The system must redact secrets from logs, tool outputs, errors, and stored observability events before persistence or display.
15. The system must minimize persisted execution residue and clean up or scrub failed job environments in production-safe defaults.
16. The system must separate durable assistant memory from transient execution state.
17. The system must support an end-to-end flow where Blob can act as an assistant, decide to perform repo work, modify its own repository, run verification, and report the result.
18. The system must provide audit-friendly records for routing decisions, capability elevations, executor runs, and cleanup outcomes.
19. The system must define interface boundaries so the repo executor can remain Cloudflare-first but not be tightly coupled to one orchestration implementation.
20. The system must include automated tests for routing, capability gating, sandbox isolation behavior, secret redaction, and repo-executor verification flows.

## 5. Non-Goals (Out of Scope)

- Replacing Cloudflare as the primary deployment target in this milestone.
- Building a platform-agnostic execution backend in this milestone.
- Supporting every possible connector or assistant integration from day one.
- Creating a general multi-user permission system with enterprise roles.
- Building a full graphical dashboard redesign.
- Solving advanced autonomous planning beyond the routing and orchestration needed for the first release.
- Implementing arbitrary self-modification without verification and safety controls.

## 6. Design Considerations (optional)

- The product should feel like one assistant, but internally it should behave as separate trust zones.
- Assistant mode should be the default user experience.
- Repo-executor mode should feel deliberate and controlled, not automatic.
- The system should make it easy to understand why a request was routed one way versus another.
- Safety-related events such as capability elevation or blocked execution should be visible in logs for operators.

## 7. Technical Considerations (optional)

- Blob is currently Cloudflare-first, so the initial implementation should use Cloudflare Sandbox, AI Gateway, R2, Durable Objects, and related infrastructure where appropriate.
- Existing code already assumes repo bootstrap and workspace operations in several paths. The new orchestrator must avoid bootstrapping repos for assistant-only work.
- Sandbox IDs must be passed through all execution, file, persistence, and cleanup paths to ensure true isolation.
- Capability policies should be centralized so multiple components do not create inconsistent security rules.
- Secret redaction should happen before data reaches logs, observability sinks, or durable storage.
- Execution-state persistence should be minimized and clearly separated from long-term assistant memory.
- Interfaces between orchestrator and executor should be explicit to support future portability.

## 8. Success Metrics

- 100% of repo-executor runs use a unique sandbox identity and do not rely on shared execution state.
- 0 known long-lived credentials are written into persistent global git configuration during bootstrap.
- 100% of tested low-trust assistant flows do not gain repo-write or bash capability unless explicitly elevated.
- Automated tests cover routing, capability gating, sandbox isolation, secret redaction, and repo verification paths.
- Blob successfully completes at least one end-to-end demo flow for each of these cases: assistant-only task, reminder/task orchestration, research/orchestration task, and self-repo modification with verification.
- Logs and stored execution artifacts pass manual review for secret leakage in staged test runs.
- The architecture is documented clearly enough that a junior developer can identify the orchestrator boundary and the executor boundary.

## 9. Open Questions

- Should capability elevation require an explicit user confirmation for some classes of actions, or is internal routing policy enough for the first release?
- What is the exact boundary between research/orchestration and repo execution when a task involves both planning and code changes?
- Should assistant memory and execution history live in separate stores or just separate namespaces in the same store?
- What is the minimum viable reminder/task feature set for the first release?
- How much execution residue should be retained for debugging in non-production environments?
- Should the repo executor support only Blob's own repository in the first milestone, or any allowed repository?