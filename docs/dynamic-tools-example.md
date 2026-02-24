# Dynamic tools: end-to-end example

This is a concrete example of what “Blob creates its own tools on the fly” looks like.

## Request

User:

```text
Inspect two directories and compare file counts.
```

## Runtime sequence

1. Blob decides this is repetitive and creates a dynamic tool:

```json
{
  "name": "create_tool",
  "input": {
    "name": "count_files",
    "description": "Count files under a path",
    "command_template": "find {path} -type f | wc -l",
    "args": ["path"]
  }
}
```

2. Blob calls the generated tool for path A:

```json
{
  "name": "count_files",
  "input": { "path": "/workspace/blob/src" }
}
```

Compiled command:

```bash
find /workspace/blob/src -type f | wc -l
```

3. Blob calls the same generated tool for path B:

```json
{
  "name": "count_files",
  "input": { "path": "/workspace/blob/tests" }
}
```

Compiled command:

```bash
find /workspace/blob/tests -type f | wc -l
```

4. Blob compares outputs and responds in plain language.

## Notes

- Tool names are sanitized to snake_case and reserved names like `bash` / `create_tool` are blocked.
- Dynamic tools are session-scoped (created at runtime, used during that loop).
- Compiled commands still pass through existing safety checks and approval gates.
