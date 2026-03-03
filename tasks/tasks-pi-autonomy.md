# Tasks: Pi-Method Full Autonomy

## Relevant Files

- `src/pi-agent.ts` - Core PiAgent class; tool registry and agent loop to be refactored
- `src/agent.ts` - Scheduled Agent class; `run()` and `commit()` stubs to be replaced
- `src/index.ts` - Worker entry point; scheduled handler wires to Agent
- `src/llm.ts` - LLM call layer; must support structured tool call request/response format
- `src/types.ts` - Shared TypeScript types; new tool/message types to be added
- `src/slack.ts` - Slack handler; must route to PiAgent via same code path as cron
- `sandbox/Dockerfile` - Sandbox container; git tooling already present, verify gh CLI
- `wrangler.agent.toml` - Agent Worker config; reference for sanitized wrangler.toml
- `wrangler.toml` - Sanitized config to be created and committed (currently gitignored)
- `.gitignore` - Must be updated to stop ignoring wrangler.toml
- `.github/workflows/deploy.yml` - CI/CD deploy workflow to be created
- `CLAUDE.md` - Self-description file for agent; to be created

### Notes

- No test framework is currently configured. Unit tests are out of scope for this task list; focus is on implementation correctness verified by end-to-end runs.
- The sandbox has outbound HTTP so GitHub API calls work from within tools.
- `GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` must be set as GitHub Actions secrets before CI/CD works.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, check it off by changing `- [ ]` to `- [x]`. Update after each sub-task, not just after completing a full parent task.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file`

## Tasks

- [ ] 0.0 Create feature branch
  - [ ] 0.1 Create and checkout branch `claude/pi-autonomy-assessment-8H6Mo`

- [ ] 1.0 Migrate PiAgent to structured JSON tool calls

- [ ] 2.0 Add git and github tools to PiAgent

- [ ] 3.0 Wire Agent.run() to PiAgent with clone-fresh-commit-PR flow

- [ ] 4.0 Add grep, find, ls tools to PiAgent

- [ ] 5.0 Add CI/CD pipeline and commit sanitized wrangler.toml

- [ ] 6.0 Register self-targeting goal and write CLAUDE.md
