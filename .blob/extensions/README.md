# Blob Extensions

Extensions let you add tools, commands, and UI components to Blob.

## Quick Start

Create an extension:
```bash
mkdir -p .blob/extensions/my-tool
cat > .blob/extensions/my-tool/tool.json << 'EOF'
{
  "name": "my-tool",
  "description": "Does something useful",
  "input_schema": {
    "type": "object",
    "properties": {
      "arg": { "type": "string" }
    }
  }
}
EOF

cat > .blob/extensions/my-tool/tool.sh << 'EOF'
#!/bin/bash
echo "Hello from my-tool!"
EOF

chmod +x .blob/extensions/my-tool/tool.sh
```

## Extension Structure

```
.blob/extensions/NAME/
  tool.json     # Tool definition (schema, description)
  tool.sh       # Implementation (bash script)
  README.md     # Documentation (optional)
```

## Tool Types

### Bash Script (`tool.sh`)
Most common. Receives arguments as env vars.

```bash
#!/bin/bash
# Access args via $1, $2, etc.
echo "Processing: $1"
```

### TUI Output
Extensions can render rich UI:

```bash
# Spinner
[[TUI:spinner:task1:Loading data...]]

# Progress
[[TUI:progress:upload:50/100:Uploading file]]

# Success
[[TUI:success:task1:Upload complete!]]
```

## Built-in Extensions

### Memory
```bash
memory --command save --key "name" --value "Alice"
memory --command get --key "name"
memory --command search --query "user preferences"
```

### Model Picker
```bash
model --command budget    # Show cost breakdown
model --command pick      # Select best model
model --command status    # Current spend
```

### Session
```bash
branch fix-bug      # Create new session branch
rewind 5            # Go back 5 messages
switch main         # Switch to branch
status              # Show all branches
```

## Examples

### Weather Tool
```json
{
  "name": "weather",
  "description": "Get weather for a location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    },
    "required": ["location"]
  }
}
```

```bash
#!/bin/bash
LOCATION="$1"
curl -s "wttr.in/${LOCATION}?format=3"
```

### Git Status Tool
```bash
#!/bin/bash
echo "[[TUI:spinner:git:Checking status...]]"
git status --short
echo "[[TUI:success:git:Done]]"
```

## Hot Reload

Extensions auto-reload when you edit `tool.json` or `tool.sh`. No restart needed!

## Best Practices

1. **Start simple** - Bash scripts are fine
2. **Use TUI** - Rich output is more engaging
3. **Document** - Add README.md for complex tools
4. **Test** - Run your tool manually first
5. **Iterate** - Hot reload makes it easy

## Advanced: TypeScript Extensions

For complex tools, use TypeScript:

```typescript
// tool.ts
export async function execute(input: { path: string }) {
  // Your logic here
  return { output: "Done!", exitCode: 0 };
}
```

Compile and reference in `tool.json`:
```json
{
  "script": "tool.js"
}
```

## Need Help?

Ask Blob: "How do I create an extension that..."
