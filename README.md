# Blob

## Dynamic tool creation example

Blob can now create a reusable tool during a session and then call it immediately.

### 1) User asks for repeated workflow

```text
List files in this repo a few times and summarize what you find.
```

### 2) Blob creates a tool at runtime

Blob can emit a `create_tool` call like:

```json
{
  "type": "tool_use",
  "name": "create_tool",
  "input": {
    "name": "list_top_files",
    "description": "List top-level files in a path",
    "command_template": "find {path} -maxdepth 1 -type f",
    "args": ["path"]
  }
}
```

Blob registers this tool for the current loop/session.

### 3) Blob invokes the generated tool

```json
{
  "type": "tool_use",
  "name": "list_top_files",
  "input": {
    "path": "/workspace/blob"
  }
}
```

The tool compiles to a bash command:

```bash
find /workspace/blob -maxdepth 1 -type f
```

…and then runs through the normal safety + approval flow exactly like regular bash usage.

### 4) Blob continues with normal reasoning

Blob receives the tool result, can call the generated tool again with different args, and then returns a final text response.

See `docs/dynamic-tools-example.md` for a full end-to-end transcript-style example.


## LLM routing

Blob now supports Cloudflare AI Gateway as the primary provider path.
For Unified Billing, configure:
- `AI_GATEWAY_BASE_URL="https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>"`
- `AI_GATEWAY_TOKEN="<Authenticated Gateway Run token>"`

Do **not** set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` Worker secrets in Unified Billing mode. Blob sends `cf-aig-authorization` for gateway auth on every request and omits provider `Authorization` unless you explicitly pass a provider key for BYOK passthrough.
Default model routing separates planning from execution: planner models are used for task planning/dedup decisions, while execution models are used by tool-calling sub-agents.

You can change models at runtime by talking to Blob in Slack (no code changes needed):
- `set planner-simple model to openai/gpt-4.1-mini`
- `set planner-complex model to anthropic/claude-sonnet-4-6`
- `set execution-simple model to @cf/qwen/qwen2.5-coder-7b-instruct`
- `set execution-complex model to @cf/qwen/qwen2.5-coder-14b-instruct`
- `show model settings`

These settings are persisted in Durable Object storage for that deployment.

## Autonomous heartbeat steering feedback

Operators can steer autonomous planning at any time by posting feedback to the agent endpoint:

```json
{
  "action": "submit_feedback",
  "feedback": "Prioritize reliability improvements over UI work",
  "channel": "C123"
}
```

Feedback is persisted with timestamp/channel metadata and is injected into the next autonomous planning cycle.
