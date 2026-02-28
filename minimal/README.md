# Minimal Autonomous Blob

A fully autonomous coding agent using the PI philosophy.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Heartbeat │────▶│   Planner   │────▶│  Executor   │
│   (5 min)   │     │  (LLM)      │     │  (LLM +     │
└─────────────┘     └─────────────┘     │   Tools)    │
                                        └─────────────┘
```

## Components

1. **Planner** - Decides what to work on based on repository goals
2. **Executor** - Executes tasks using tools (read, write, edit, bash)
3. **Heartbeat** - Runs every 5 minutes to self-improve

## Tools (4 core)

- `read` - Read files
- `write` - Write files  
- `edit` - Edit files
- `bash` - Run shell commands

## Configuration

Set in `wrangler.toml` or via environment:

```
GOALS="improve test coverage; fix bugs; add documentation"
REPO="kyleboas/blob"
```

## No Human in the Loop

- No approval gates
- No confirmation prompts
- Auto-commit and push on success
- Self-healing on failure
