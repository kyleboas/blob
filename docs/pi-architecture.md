# Pi-Style Blob Architecture

## Core Philosophy
- **4 tools only**: Read, Write, Edit, Bash
- **Agent builds everything**: GitHub, web search, weather - all built on demand
- **Self-extending**: Agent writes its own extensions
- **Session trees**: Branch and rewind conversations
- **Hot reloading**: Test changes without restart

## Core Tools

### 1. Read
```typescript
{
  name: "read",
  description: "Read file contents",
  input: { path: string }
}
```

### 2. Write
```typescript
{
  name: "write", 
  description: "Write file contents (creates or overwrites)",
  input: { path: string, content: string }
}
```

### 3. Edit
```typescript
{
  name: "edit",
  description: "Edit file by replacing text",
  input: { path: string, oldText: string, newText: string }
}
```

### 4. Bash
```typescript
{
  name: "bash",
  description: "Execute bash command",
  input: { command: string, timeout?: number }
}
```

## Extension System

Extensions are stored in `.blob/extensions/` and auto-loaded.

Example extension structure:
```
.blob/extensions/
  github/
    tool.json       # Tool definition
    tool.sh         # Implementation
  web-search/
    tool.json
    tool.sh
```

## Session Trees

Sessions are stored as trees, not linear history:
```
root/
├── main-session/
│   ├── branch-fix-bug/
│   │   └── [commits...]
│   └── branch-try-alternative/
│       └── [commits...]
```

Can rewind to any point and branch.

## Hot Reloading

After writing an extension:
1. Extension is saved to disk
2. Auto-reloaded into current session
3. Available immediately without restart

## Implementation Plan

1. **Remove all built-in tools** except Read/Write/Edit/Bash
2. **Add extension system** - load from `.blob/extensions/`
3. **Add session tree storage** - SQLite with parent pointers
4. **Add hot reload** - file watcher for extensions
5. **Shorten system prompt** - minimal instructions
6. **Add self-extension examples** - show agent how to build tools
