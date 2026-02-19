# Tasks: Migrate Blob Agent from Fly.io to Cloudflare

## Relevant Files

- `wrangler.toml` - Cloudflare Worker configuration: bindings for Durable Objects, R2, Sandbox, secrets, and compatibility settings.
- `src/index.ts` - Worker entry point: HTTP fetch handler for Slack webhooks, health checks, and routing to Durable Objects.
- `src/index.test.ts` - Unit tests for the Worker entry point.
- `src/agent.ts` - Core agent Durable Object: ReAct loop, LLM tool-calling dispatch, step limiting, conversation management. Extends the Agents SDK `Agent` base class.
- `src/agent.test.ts` - Unit tests for the agent Durable Object.
- `src/llm.ts` - LLM client abstraction: Anthropic API calls via fetch, model routing (Haiku/Sonnet), prompt caching, system prompt construction.
- `src/llm.test.ts` - Unit tests for the LLM client.
- `src/sandbox-client.ts` - Sandbox abstraction layer: wraps Sandbox SDK calls (`exec`, `writeFile`, `readFile`), timeout enforcement, output truncation.
- `src/sandbox-client.test.ts` - Unit tests for the sandbox client.
- `src/safety.ts` - Safety enforcement: rate limiting (DO SQLite counters), constitution rules (protected file list), command classification.
- `src/safety.test.ts` - Unit tests for safety enforcement.
- `src/approval.ts` - Approval gate logic: post approval requests to Slack, wait for callback via DO alarm, enforce timeout, record decisions in DO SQLite.
- `src/approval.test.ts` - Unit tests for approval gates.
- `src/slack.ts` - Slack integration: webhook signature verification, event parsing, message posting, reaction handling, thread-to-DO routing.
- `src/slack.test.ts` - Unit tests for Slack integration.
- `src/storage.ts` - Storage layer: DO SQLite schema and queries (state, history, rate limits, knowledge), R2 operations (repo snapshot save/restore).
- `src/storage.test.ts` - Unit tests for the storage layer.
- `src/tools.ts` - Tool definitions: bash tool JSON schema, tool-result formatting, tool-call parsing.
- `src/tools.test.ts` - Unit tests for tool definitions.
- `src/types.ts` - Shared TypeScript type definitions: agent state, messages, tool calls, Slack events, configuration.
- `src/config.ts` - Configuration constants: max steps, timeouts, rate limits, model names, protected files list.
- `package.json` - Node.js project metadata and dependencies.
- `tsconfig.json` - TypeScript compiler configuration.
- `vitest.config.ts` - Test runner configuration (Vitest, recommended for Cloudflare Workers).

### Notes

- Unit tests should be placed alongside the code files they test (e.g., `src/agent.ts` and `src/agent.test.ts` in the same directory).
- Use `npx vitest` to run tests. Vitest is the recommended test runner for Cloudflare Workers projects (better Workers runtime support than Jest).
- The Cloudflare Agents SDK is TypeScript-first. Reference: https://developers.cloudflare.com/agents/
- The Sandbox SDK is in Beta. Reference: https://developers.cloudflare.com/sandbox/
- Existing Python source files (`agent.py`, `llm_client.py`, etc.) should be preserved until the migration is verified complete.

## Instructions for Completing Tasks

IMPORTANT: As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

## Tasks

- [x] 0.0 Create feature branch
  - [x] 0.1 Create and checkout a new branch for this feature (e.g., `git checkout -b feature/migrate-cloudflare`)

- [x] 1.0 Initialize Cloudflare Worker project
  - [x] 1.1 Run `npm init -y` in project root to create `package.json` (or update existing if present). Add `"type": "module"` and set `"main": "src/index.ts"`.
  - [x] 1.2 Install core dependencies: `wrangler`, `@cloudflare/agents`, `@cloudflare/sandbox` (check latest package names from Cloudflare docs).
  - [x] 1.3 Install dev dependencies: `typescript`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`.
  - [x] 1.4 Create `tsconfig.json` with Cloudflare Workers-compatible settings (target: ESNext, module: ESNext, moduleResolution: bundler, types: `@cloudflare/workers-types`).
  - [x] 1.5 Create `vitest.config.ts` configured for Workers pool (`@cloudflare/vitest-pool-workers`).
  - [x] 1.6 Create `wrangler.toml` with: Worker name (`blob-agent`), compatibility date, Durable Object binding (AgentDO), R2 bucket binding (`REPO_STORE`), Sandbox binding, and secret references (`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`).
  - [x] 1.7 Create `src/types.ts` with shared type definitions: `Env` interface (Worker bindings), `AgentState`, `ConversationMessage`, `ToolCall`, `ToolResult`, `SlackEvent`.
  - [x] 1.8 Create `src/config.ts` with configuration constants ported from Python `config.py`: `MAX_STEPS`, `COMMAND_TIMEOUT`, `MEMORY_LIMIT_MB`, `SELF_MODIFY_LIMIT_SESSION`, `SELF_MODIFY_LIMIT_DAY`, `APPROVAL_TIMEOUT_MINUTES`, `MODEL_ROUTINE`, `MODEL_COMPLEX`, `PROTECTED_FILES`.
  - [x] 1.9 Verify the project compiles with `npx wrangler deploy --dry-run` (or `npx tsc --noEmit`).

- [x] 2.0 Implement LLM client and tool definitions
  - [x] 2.1 Create `src/tools.ts`: define the bash tool JSON schema (matching Anthropic's tool_use format), implement `formatToolResult()` helper for truncating output and formatting responses.
  - [x] 2.2 Create `src/llm.ts`: implement `callLLM()` function that calls the Anthropic Messages API via `fetch()`. Support parameters: model selection (routine vs complex), system prompt, conversation messages, tools array, prompt caching headers.
  - [x] 2.3 Implement model routing logic in `src/llm.ts`: use `MODEL_ROUTINE` (Haiku 4.5) by default, escalate to `MODEL_COMPLEX` (Sonnet 4.6) when the system prompt or tool call indicates complex reasoning.
  - [x] 2.4 Write unit tests in `src/llm.test.ts`: test API request formation, model routing, error handling (rate limits, API errors), and response parsing.
  - [x] 2.5 Write unit tests in `src/tools.test.ts`: test tool schema validity, output truncation, and tool result formatting.

- [x] 3.0 Implement sandbox client
  - [x] 3.1 Create `src/sandbox-client.ts`: implement `SandboxClient` class that wraps the Sandbox SDK. Methods: `exec(command, timeout?)`, `writeFile(path, content)`, `readFile(path)`, `fileExists(path)`.
  - [x] 3.2 Implement timeout enforcement in `exec()`: kill long-running commands after `COMMAND_TIMEOUT` seconds, return timeout error message.
  - [x] 3.3 Implement output truncation in `exec()`: cap stdout/stderr to a configurable max length (e.g., 10,000 chars) to avoid blowing up the LLM context.
  - [x] 3.4 Implement command-injection detection: port the pattern checks from Python `sandbox.py` (block commands containing `$(`, backticks targeting sensitive paths, etc.) — enforce in the orchestration layer before sending to sandbox.
  - [x] 3.5 Write unit tests in `src/sandbox-client.test.ts`: test exec calls, timeout handling, output truncation, and command validation. Mock the Sandbox SDK binding.

- [x] 4.0 Implement storage layer (DO SQLite + R2)
  - [x] 4.1 Create `src/storage.ts`: define the DO SQLite schema — tables for `conversation_messages`, `agent_state`, `rate_limits`, `approval_log`, `knowledge`.
  - [x] 4.2 Implement SQLite helper functions: `initSchema(sql)`, `saveMessage(sql, msg)`, `getHistory(sql, threadId)`, `incrementRateLimit(sql, scope, key)`, `getRateLimit(sql, scope, key)`, `saveKnowledge(sql, content)`, `getKnowledge(sql)`.
  - [x] 4.3 Implement R2 helper functions: `saveRepoSnapshot(r2, sessionId, sandbox)` — reads key workspace files from sandbox and stores them in R2. `restoreRepoSnapshot(r2, sessionId, sandbox)` — writes stored files back to the sandbox container.
  - [x] 4.4 Implement knowledge persistence: `syncKnowledgeToSandbox(sql, sandbox)` — reads knowledge from DO SQLite and writes it as `AGENT.md` in the sandbox workspace. `syncKnowledgeFromSandbox(sql, sandbox)` — reads `AGENT.md` from sandbox and updates DO SQLite.
  - [x] 4.5 Write unit tests in `src/storage.test.ts`: test schema initialization, CRUD operations for all tables, R2 save/restore logic (mock R2 binding), knowledge sync.

- [x] 5.0 Implement safety enforcement in orchestration layer
  - [x] 5.1 Create `src/safety.ts`: implement `checkRateLimit(sql, sessionId)` — queries DO SQLite for session and daily self-modification counts, returns allow/deny.
  - [x] 5.2 Implement `classifyCommand(command)` — categorize a bash command as: `auto_approve` (read-only, e.g., `cat`, `ls`, `git status`), `conditional` (workspace writes), or `requires_approval` (modifies protected files, destructive git operations).
  - [x] 5.3 Implement `checkConstitution(command, files)` — given a command and the files it may affect, check if any protected files are being modified. Return the list of violations.
  - [x] 5.4 Implement `enforeSafety(command, sql, sessionId)` — orchestrate rate limit check, command classification, and constitution check. Return a decision: `{ allowed: boolean, reason?: string, requiresApproval?: boolean }`.
  - [x] 5.5 Write unit tests in `src/safety.test.ts`: test rate limit enforcement (within limits, at limits, over limits), command classification for various commands, constitution violation detection, and the combined `enforceSafety` flow.

- [x] 6.0 Implement Slack integration (Events API)
  - [x] 6.1 Create `src/slack.ts`: implement `verifySlackSignature(request, signingSecret)` — verify the `x-slack-signature` and `x-slack-request-timestamp` headers against the request body using HMAC-SHA256.
  - [x] 6.2 Implement `parseSlackEvent(body)` — parse incoming Slack Events API payloads. Handle `url_verification` challenges, `event_callback` with `message` events, and `reaction_added` events.
  - [x] 6.3 Implement `postMessage(token, channel, text, threadTs?)` — post a message to Slack via the `chat.postMessage` API using `fetch()`.
  - [x] 6.4 Implement `postApprovalRequest(token, channel, threadTs, description)` — post a message asking for approval with instructions to react with thumbsup/thumbsdown.
  - [x] 6.5 Implement `mapThreadToDO(threadTs)` — derive a Durable Object ID from a Slack thread timestamp (deterministic mapping so the same thread always routes to the same DO).
  - [x] 6.6 Write unit tests in `src/slack.test.ts`: test signature verification (valid, invalid, expired), event parsing for all event types, message posting (mock fetch), thread-to-DO mapping consistency.

- [x] 7.0 Implement core agent Durable Object
  - [x] 7.1 Create `src/agent.ts`: define the `AgentDO` class extending the Agents SDK `Agent` base class. Initialize DO SQLite schema in constructor (or on first request).
  - [x] 7.2 Implement the `fetch()` handler on the DO: accept task messages from the Worker, parse the incoming Slack event, and initiate the agent loop.
  - [x] 7.3 Implement the ReAct loop: `runAgentLoop(task, threadTs)` — iteratively call the LLM, parse tool calls, enforce safety, execute approved tools via sandbox, append observations, and repeat until the LLM produces a final text response or `MAX_STEPS` is reached.
  - [x] 7.4 Implement tool dispatch within the loop: when the LLM returns a `tool_use` block for the bash tool, call `enforceSafety()`, handle approval gates if needed, then execute via `SandboxClient.exec()`.
  - [x] 7.5 Implement approval gate flow: when a command `requiresApproval`, post an approval request to Slack, set a DO alarm for the timeout, and pause the loop. On receiving a reaction callback, resume the loop with the approval decision.
  - [x] 7.6 Implement session lifecycle: on task start, create/wake the sandbox, restore repo from R2, sync knowledge. On task end, persist repo to R2, sync knowledge back, and post the final result to Slack.
  - [x] 7.7 Implement git safety operations: before risky modifications, execute `git add -A && git commit -m "checkpoint"` in the sandbox. After test failures, execute `git revert` or `git reset`. Trigger these from the orchestration layer via sandbox exec calls.
  - [x] 7.8 Implement step limiting and conversation management: track step count, enforce `MAX_STEPS`, maintain the conversation messages array, persist to DO SQLite after each step.
  - [x] 7.9 Write unit tests in `src/agent.test.ts`: test the ReAct loop with mocked LLM responses and sandbox, test approval gate flow, test rate limit enforcement, test step limiting, test session lifecycle (snapshot save/restore).

- [ ] 8.0 Implement Worker entry point and wiring
  - [ ] 8.1 Create `src/index.ts`: implement the Worker `fetch()` handler. Route requests: `/slack/events` → Slack event handling, `/health` → health check response.
  - [ ] 8.2 Implement Slack event routing in the Worker: verify signature, parse event, handle `url_verification` directly, route `message` and `reaction_added` events to the appropriate DO (using `mapThreadToDO()`).
  - [ ] 8.3 For `message` events: get the DO stub, forward the task. Return `200 OK` to Slack immediately (within 3 seconds), let the DO process asynchronously.
  - [ ] 8.4 For `reaction_added` events: route to the corresponding DO to resolve pending approval gates.
  - [ ] 8.5 Write unit tests in `src/index.test.ts`: test routing, signature verification pass-through, health check, Slack challenge response, event forwarding to DO.

- [ ] 9.0 Integration testing and deployment
  - [ ] 9.1 Write an integration test that exercises the full flow: Worker receives a Slack event → routes to DO → DO calls LLM (mocked) → DO executes command in sandbox (mocked) → DO posts result to Slack (mocked). Verify state is persisted in DO SQLite.
  - [ ] 9.2 Deploy to Cloudflare with `npx wrangler deploy`. Create the R2 bucket (`wrangler r2 bucket create blob-repo-store`). Set secrets (`wrangler secret put ANTHROPIC_API_KEY`, etc.).
  - [ ] 9.3 Configure the Slack app: update the Event Subscriptions Request URL to the Worker's `/slack/events` endpoint. Subscribe to `message.im` and `reaction_added` events. Disable Socket Mode.
  - [ ] 9.4 Smoke test: send a message to the Slack bot and verify end-to-end flow — message received, agent processes, sandbox executes, result posted back to Slack.
  - [ ] 9.5 Verify persistence: complete a task, wait for sandbox to scale to zero, send a follow-up message in the same thread — verify conversation history and knowledge are preserved.
  - [ ] 9.6 Verify safety: attempt to exceed rate limits, attempt to modify a protected file without approval, verify the orchestration layer blocks these correctly.
  - [ ] 9.7 Update `DEPLOY.md` with Cloudflare deployment instructions replacing the Fly.io guide.
  - [ ] 9.8 Remove or archive Fly.io configuration files (`fly.toml`, `Dockerfile`, `.github/workflows/deploy-fly.yml`) after confirming Cloudflare deployment is stable.
