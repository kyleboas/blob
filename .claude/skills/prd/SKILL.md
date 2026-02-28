---
name: prd-and-tasks
description: Generate a PRD in /tasks/prd-<feature-slug>.md (after 3–5 essential clarifying questions) AND a two-phase implementation task list in /tasks/tasks-<feature-slug>.md (parent tasks first, wait for 'Go', then sub-tasks + relevant files).
disable-model-invocation: true
---

You are in "PRD + TASKS mode". Follow this exact process.

PHASE 1 — Clarify (do not write the PRD yet)
1) Ask 3–5 clarifying questions ONLY (no extra commentary).
2) Number questions (1, 2, 3...) and provide A/B/C/D options for each.
3) Questions must focus on: problem/goal, core functionality, scope boundaries, success criteria.
4) End PHASE 1 by asking the user to reply with selections like "1A, 2C, 3B".
5) STOP after the questions and wait for the user's answers.

PHASE 2 — Write PRD (only after user answers)
1) Infer a feature slug in lowercase-kebab-case from the prompt (or use a short slug if provided).
2) Create /tasks/prd-<slug>.md (make /tasks if missing).
3) Write a PRD in Markdown with these sections:
   1. Introduction/Overview
   2. Goals (specific + measurable)
   3. User Stories
   4. Functional Requirements (numbered “The system must…” statements)
   5. Non-Goals (Out of Scope)
   6. Design Considerations (optional)
   7. Technical Considerations (optional)
   8. Success Metrics
   9. Open Questions
4) Assume the reader is a junior developer: explicit, unambiguous, minimal jargon.
5) Do NOT implement anything. Do NOT modify other files beyond creating the PRD.
6) After writing the file, respond with:
   - The path you wrote
   - A 1–2 line summary of what’s in it

PHASE 3 — Generate Task List (Phase 1: Parent Tasks only)
1) Create /tasks/tasks-<slug>.md.
2) Generate high-level parent tasks based on the PRD.
3) ALWAYS include task 0.0 "Create feature branch" first, unless the user explicitly requests no branch.
4) Use ~5 additional parent tasks (use judgement).
5) Output MUST follow the "Task List Output Format" section below, but in this phase include:
   - "## Relevant Files" (may be a short placeholder list if unsure)
   - "### Notes"
   - "## Instructions for Completing Tasks"
   - "## Tasks" with ONLY:
     - 0.0 and 0.1
     - each parent task (1.0, 2.0, 3.0...) with NO sub-tasks yet
6) End PHASE 3 by saying exactly:
   "I have generated the high-level tasks based on your requirements. Ready to generate the sub-tasks? Respond with 'Go' to proceed."
7) STOP and wait for the user to respond with "Go".

PHASE 4 — Generate Task List (Phase 2: Sub-Tasks + Relevant Files)
(Only after the user responds with "Go")
1) Expand each parent task into actionable sub-tasks (1.1, 1.2, ...).
2) Identify relevant files likely to be created/modified, including test files where applicable.
3) Ensure sub-tasks cover the implementation details implied by the PRD.
4) Output the final /tasks/tasks-<slug>.md content in the required format below.
5) Do NOT implement code. This is planning only.

Task List Output Format (must match)

## Relevant Files

- `path/to/potential/file1.ts` - Brief description of why this file is relevant (e.g., Contains the main component for this feature).
- `path/to/file1.test.ts` - Unit tests for `file1.ts`.
- `path/to/another/file.tsx` - Brief description (e.g., API route handler for data submission).
- `path/to/another/file.test.tsx` - Unit tests for `another/file.tsx`.
- `lib/utils/helpers.ts` - Brief description (e.g., Utility functions needed for calculations).
- `lib/utils/helpers.test.ts` - Unit tests for `helpers.ts`.

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
  - [ ] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/<slug>`)
- [ ] 1.0 Parent Task Title
  - [ ] 1.1 Sub-task description
  - [ ] 1.2 Sub-task description
- [ ] 2.0 Parent Task Title
  - [ ] 2.1 Sub-task description
- [ ] 3.0 Parent Task Title (may not require sub-tasks if purely structural or configuration)