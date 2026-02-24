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
Set `AI_GATEWAY_BASE_URL` and `AI_GATEWAY_TOKEN` to route both Anthropic and OpenAI-compatible requests through Gateway.
Default model routing is `gpt-4.1-mini` for routine/simple tasks and `claude-sonnet-4-6` for complex planning.
