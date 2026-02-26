## Relevant Files

- `tasks/prd-self-healing-error-fix-pr.md` - Source requirements and acceptance criteria for implementation decisions.
- `src/error-ingestion/index.ts` - Entry point for collecting and normalizing in-scope errors from CI/runtime/test/lint/type sources.
- `src/error-ingestion/classifier.ts` - Determines eligibility and remediation routing based on error fingerprint and policy.
- `src/remediation-engine/index.ts` - Coordinates fix generation, patch application, and remediation attempt lifecycle.
- `src/remediation-engine/patch-safety.ts` - Enforces safe edit boundaries and guards against unsafe file modifications.
- `src/validation/index.ts` - Runs configured validation gates, including full test suite execution.
- `src/validation/commands.ts` - Resolves repository-specific command sets and fallback defaults.
- `src/pr-automation/index.ts` - Creates branch names, commits generated fixes, pushes refs, and opens PRs.
- `src/pr-automation/pr-template.ts` - Builds structured PR bodies with error summary and validation output.
- `src/deduplication/fingerprints.ts` - Prevents duplicate PRs for unresolved identical failures.
- `src/observability/events.ts` - Emits lifecycle events (detected, remediating, validating, PR opened, failed).
- `src/config/policy.ts` - Defines configurable scope boundaries and validation policy behavior.
- `tests/error-ingestion/classifier.test.ts` - Unit tests for eligibility classification and source normalization.
- `tests/remediation-engine/index.test.ts` - Unit/integration tests for fix generation/apply flow and failure handling.
- `tests/validation/index.test.ts` - Verifies full-suite gate behavior and required-check pass/fail outcomes.
- `tests/pr-automation/index.test.ts` - Tests branch naming, PR creation payloads, and push sequencing.
- `tests/deduplication/fingerprints.test.ts` - Tests duplicate prevention behavior for recurring unresolved errors.
- `tests/e2e/self-healing-flow.test.ts` - End-to-end flow test from detected error to opened PR.

### Notes

- Unit tests should typically be placed alongside the code files they are testing (e.g., `MyComponent.tsx` and `MyComponent.test.tsx` in the same directory).
- Use `npx jest [optional/path/to/test/file]` to run tests. Running without a path executes all tests found by the Jest configuration.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/self-healing-error-fix-pr`)

- [ ] 1.0 Define error ingestion and eligibility criteria for autonomous remediation
  - [ ] 1.1 Enumerate and document in-scope error sources for v1 (CI, runtime logs, lint/type/test failures).
  - [ ] 1.2 Implement error normalization to convert source-specific payloads into a common error schema.
  - [ ] 1.3 Implement error classification rules that decide whether an error is eligible for autonomous remediation.
  - [ ] 1.4 Add deterministic error fingerprinting fields for downstream deduplication and tracking.
  - [ ] 1.5 Add unit tests for ingestion, normalization, and eligibility classification behavior.

- [ ] 2.0 Build remediation workflow to generate and apply candidate fixes
  - [ ] 2.1 Implement remediation orchestrator that transitions through detect → propose fix → apply patch states.
  - [ ] 2.2 Integrate fix generation strategy with repository context and failing signal inputs.
  - [ ] 2.3 Add patch application safeguards (scope boundaries, file allowlist/denylist, max-change limits).
  - [ ] 2.4 Implement failure handling and retry/backoff policy for unsuccessful remediation attempts.
  - [ ] 2.5 Add tests for successful patch application and guarded failure scenarios.

- [ ] 3.0 Implement validation gate that runs required checks including full test suite
  - [ ] 3.1 Define validation policy model (required vs optional checks, default behavior, per-repo overrides).
  - [ ] 3.2 Implement command resolver for lint/typecheck/test commands with sensible fallbacks.
  - [ ] 3.3 Implement validation runner to execute checks and capture structured pass/fail output.
  - [ ] 3.4 Enforce hard stop when required checks fail so PR creation is blocked.
  - [ ] 3.5 Add tests for full-suite success paths and required-check failure blocking.

- [ ] 4.0 Implement branch creation and pull request automation for successful remediations
  - [ ] 4.1 Implement deterministic branch naming convention using error fingerprint + timestamp.
  - [ ] 4.2 Implement commit creation with descriptive message linking to remediation attempt metadata.
  - [ ] 4.3 Implement push and PR creation workflow for validated remediation branches.
  - [ ] 4.4 Generate structured PR body including error summary, files changed, commands run, and outcomes.
  - [ ] 4.5 Add tests for branch naming, commit/PR payload generation, and PR creation sequencing.

- [ ] 5.0 Add observability, safeguards, and duplicate-prevention controls
  - [ ] 5.1 Implement lifecycle event emission for detected, remediating, validating, opened, and failed statuses.
  - [ ] 5.2 Implement duplicate-prevention checks to avoid multiple open PRs for unresolved identical fingerprints.
  - [ ] 5.3 Add configurable guardrails for remediation scope, execution timeouts, and retry limits.
  - [ ] 5.4 Add structured logs/metrics for success rate, time-to-PR, and validation pass rate.
  - [ ] 5.5 Add tests for duplicate-prevention behavior and observability event coverage.

- [ ] 6.0 Add automated tests and rollout documentation for the autonomous remediation flow
  - [ ] 6.1 Implement end-to-end tests for the full self-healing workflow from error detection to PR creation.
  - [ ] 6.2 Add negative e2e scenarios where validation fails and PR creation is correctly skipped.
  - [ ] 6.3 Document operator configuration for error sources, validation policy, and remediation boundaries.
  - [ ] 6.4 Document runbook guidance for monitoring, triaging failures, and safe rollback/disable procedures.
  - [ ] 6.5 Define launch checklist and success-metric review plan for post-release evaluation.
