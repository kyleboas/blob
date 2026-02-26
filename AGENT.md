# Blob Agent Knowledge Base

This file contains generic knowledge about Blob's architecture and capabilities.

**User-specific configuration is stored in Cloudflare KV, not here.** See `DEPLOYMENT.md` and `config-template.json` for customization instructions.

## Identity & Architecture

Blob is a self-modifying AI agent built on Cloudflare Workers with TypeScript.

**Codebase structure:**
- `src/` — TypeScript/Cloudflare implementation
  - `agent.ts` — main agent orchestration and execution loop
  - `config.ts` — configuration constants and factory functions
  - `kv-loader.ts` — loads user configuration from Cloudflare KV
  - `kv-schema.ts` — TypeScript interfaces for user configuration
  - `storage.ts` — D1 database operations
  - `safety.ts` — command safety and rate limiting
  - `approval.ts` — approval gate logic
  - `tools.ts` — tool definitions and execution
  - `types.ts` — TypeScript interfaces
  - `slack.ts` — Slack integration
  - `llm.ts` — LLM client and routing

- Documentation:
  - `AGENT.md` — this file
  - `DEPLOYMENT.md` — setup guide for custom deployments
  - `config-template.json` — example user configuration

## Configuration & Customization

**User configuration is stored in Cloudflare KV**, not in code.

When deployed:
1. Blob loads user configuration from KV key `"user-configuration"`
2. Configuration is cached for 5 minutes per instance
3. Falls back to hardcoded defaults if KV unavailable

**Configuration includes:**
- User profile (name, GitHub username, project URL)
- Message formatting preferences
- Execution guardrails and safety rules
- Rate limiting (self-modification limits, approval timeouts)
- Model routing (which models to use for routine vs complex tasks)
- Tool configuration (timeouts, retries)
- System prompt behavior (autonomous startup checks, etc.)

**To customize for a deployment:**
1. Use `config-template.json` as a starting point
2. Customize with your values (profile, guardrails, preferences)
3. Upload to Cloudflare KV with key `"user-configuration"`
4. Redeploy the Worker

See `DEPLOYMENT.md` for detailed setup instructions.

## Capabilities & Limitations

**What Blob can do:**
- Execute shell commands via Cloudflare Workers sandbox
- Modify TypeScript source code (subject to approval gates)
- Create and commit git changes
- Create pull requests on any GitHub repository
- Self-improve by reading and modifying its own source code
- Persist conversation history in Cloudflare D1
- Learn from previous interactions (via knowledge storage in D1)

**What requires human approval:**
- Any modification to constitutional files (`src/agent.ts`, `src/safety.ts`, `src/approval.ts`, `src/config.ts`, `src/sandbox-client.ts`, `src/slack.ts`)
- Any self-modification operation beyond read-only commands
- Approval requests are sent to Slack and timeout after 30 minutes

**Key constraints:**
- Command timeout: 30 seconds
- Max steps per task: 25
- Memory limit: 512 MB per command
- Rate limits: 3 self-modifications per session, 10 per day (configurable via KV)
- Output is truncated at ~10KB per command

## Approval & Safety

Commands are classified into three tiers:

| Tier | Trigger | Approval needed? |
|------|---------|------------------|
| `auto-approve` | Read-only (`cat`, `ls`, `git log`, `grep`, etc.) | No |
| `conditional` | Writes, git commits, tool execution, etc. | Yes |
| `requires-approval` | Dangerous commands (`git reset --hard`, `rm -rf`, etc.) | Yes |

Approval requests go to Slack and auto-reject after `approvalTimeoutMinutes` (default: 30 min).

## Execution Flow

1. **Request received** via Slack or HTTP
2. **Parse task** and validate inputs
3. **Load user configuration** from KV (cached 5 min)
4. **Build system prompt** with user guardrails from config
5. **Execute agent loop:**
   - Call LLM with system prompt + conversation history
   - Parse tool calls from LLM response
   - Execute tools (subject to safety checks)
   - Collect results and continue loop
6. **Save results** to D1 (conversation history, knowledge, events)
7. **Return response** to user

## Model Routing

The agent can route tasks to different LLM models based on complexity.

Configuration specifies:
- `defaultModel` — for routine tasks (e.g., Claude Haiku)
- `complexTaskModel` — for complex tasks (e.g., Claude Sonnet)
- `complexTaskKeywords` — keywords that trigger complex model (e.g., "refactor", "architecture", "security")

## Git & Commits

- Every file modification is auto-committed
- Commit messages follow pattern: `type: description`
- Checkpoints are created before risky operations
- Failed operations can be reverted via `git revert`

## Patterns & Best Practices

- Check `git log --oneline -10` to understand recent changes
- Use `git diff HEAD~1` to inspect the last change
- For URL-related tasks, fetch content with `curl` before summarizing
- Run tests after code modifications to verify correctness
- Prefer targeted edits over full rewrites (via sed or echo >>)
- Check for pending tasks in the backlog before starting new work

## Gotchas & Constraints

- **Cloudflare sandbox limitations**: Command substitution `$()` is blocked; use direct tool invocation instead
- **Output truncation**: Large command outputs are cut at ~10KB; use `head`, `tail`, or filtering
- **Git state issues**: Always check `git status` before committing; dirty state prevents auto-commit
- **Constitutional files**: Even one-character fixes require human approval
- **Rate limiting**: Resets at midnight UTC, not local time
- **Approval timeout**: 30 minutes by default; configure via KV `approvalTimeoutMinutes`
- **Configuration cache**: Changes to KV config take ~5 minutes to propagate or require redeployment
- **Network access**: Only whitelisted domains reachable (Anthropic, GitHub, PyPI, etc.)

## Knowledge & Memory

Blob maintains persistent knowledge in Cloudflare D1:

- **Conversation history** — every message in a thread
- **Knowledge base** — learnings, patterns, summaries
- **Agent events** — traces of operations and decisions
- **Rate limit counters** — self-modification tracking

This knowledge is loaded into the system prompt and informs future decisions within the same session.

## Extending Blob

To add new capabilities:

1. **Create a new tool** — define in `src/tools.ts`
2. **Update safety rules** — add patterns to `src/safety.ts` if needed
3. **Submit a PR** — open PR against kyleboas/blob with clear description
4. **Get approved** — human review and testing required
5. **Deploy** — merge to main and redeploy to Cloudflare

For more information, see the source code and inline documentation.
