# Deployment Guide: Cloudflare KV Configuration

This guide explains how to set up Blob for your Cloudflare Worker deployment with custom user configuration stored in Cloudflare KV.

## Architecture

- **GitHub repo** (`kyleboas/blob`): Contains code only, fully distributable
- **Cloudflare KV**: Stores all user-specific configuration (profile, preferences, guardrails, task queue, etc.)
- **Cloudflare D1**: Stores operational data (conversation history, audit logs, etc.)

This separation allows you to:
- Fork the Blob repository and deploy your own instance
- Customize every aspect without modifying the codebase
- Version control only your configuration, not Blob's code

## Setup Steps

### 1. Create a Cloudflare KV Namespace

Create a KV namespace for your Blob instance (optionally with preview namespace for staging):

```bash
wrangler kv:namespace create "USER_CONFIG"
wrangler kv:namespace create "USER_CONFIG" --preview
```

This will output namespace IDs to add to your `wrangler.toml`.

### 2. Update wrangler.toml

Add the KV namespace bindings:

```toml
[[env.production.kv_namespaces]]
binding = "USER_CONFIG_KV"
id = "your-namespace-id"

[[env.production.kv_namespaces]]
binding = "USER_CONFIG_KV"
id = "your-preview-namespace-id"
preview = true
```

### 3. Populate Initial Configuration

Use the template configuration file (`config-template.json`) as a starting point:

```bash
# Read the template
cat config-template.json

# Customize it for your deployment
# (Edit the template with your profile, preferences, etc.)
cp config-template.json config-custom.json
# Edit config-custom.json with your values...

# Upload to KV
wrangler kv:key put --namespace-id YOUR_KV_ID --path config-custom.json "user-configuration"
```

Alternatively, use the Cloudflare Dashboard to create the KV key directly.

### 4. Deploy

```bash
wrangler deploy --env production
```

## Configuration Schema

User configuration is stored as a single JSON object in KV with key `"user-configuration"`.

See `src/kv-schema.ts` for the TypeScript interface, or use `config-template.json` as a reference.

### Key Sections

| Section | Purpose | Example |
|---------|---------|---------|
| `user` | Your GitHub identity and profile | `{ "name": "Kyle Boas", "githubUsername": "kyleboas" }` |
| `messageFormatting` | How messages are formatted for output | `{ "maxCharacters": 255, "includeEmojis": false }` |
| `guardrails` | Execution rules and constraints | `{ "executionMode": "follow the plan", "rules": [...] }` |
| `rateLimits` | Rate limiting for self-modification and approvals | `{ "selfModifyPerSession": 3, "approvalTimeoutMinutes": 30 }` |
| `modelRouting` | Which models to use for routine vs complex tasks | `{ "defaultModel": "claude-haiku", "complexTaskModel": "claude-sonnet" }` |
| `toolConfig` | Tool execution timeouts and retries | `{ "timeoutMs": 30000, "retryAttempts": 3 }` |
| `systemPrompt` | Autonomous startup behavior | `{ "autonomousStartupChecks": true, "checkTasksJsonFirst": true }` |

## Configuration Precedence

When Blob starts, it loads configuration in this order:

1. **Cloudflare KV** (if binding exists and key found)
2. **Environment variable** (if `USER_CONFIG_JSON` env var set)
3. **Hardcoded defaults** (fallback in `src/kv-schema.ts`)

This means:
- Deployments with KV configured will use KV configuration
- Deployments without KV will fall back to hardcoded defaults
- You can override with `USER_CONFIG_JSON` environment variable for testing

## Testing Configuration Changes

When you update configuration in KV, the change takes effect on the next request. Configuration is cached for 5 minutes per Durable Object instance for performance.

To force a reload immediately:
1. Update the configuration in KV
2. Redeploy the Worker (this cycles Durable Objects)

Or wait 5 minutes for the cache to expire naturally.

## Examples

### Example 1: Standard Personal Deployment

```json
{
  "version": "1.0",
  "user": {
    "name": "Alice Developer",
    "githubUsername": "alice-dev",
    "primaryRepository": "alice-dev/research-agent",
    "description": "AI research agent for trend analysis"
  },
  "messageFormatting": {
    "maxCharacters": 255,
    "includeEmojis": false,
    "markdownStyle": "code-blocks-only"
  },
  "guardrails": {
    "executionMode": "follow the approved plan and complete the requested task only",
    "preferDeterministic": true,
    "onBlockedBehavior": "report-and-stop",
    "allowSpeculativeChanges": false,
    "rules": [
      "Prefer deterministic tool use with minimal steps",
      "Use only provided tools and avoid speculative or unrelated changes",
      "If blocked, report the blocker clearly and stop instead of guessing"
    ]
  },
  "rateLimits": {
    "selfModifyPerSession": 3,
    "selfModifyPerDay": 10,
    "approvalTimeoutMinutes": 30,
    "commandTimeoutMs": 30000
  },
  "modelRouting": {
    "defaultModel": "claude-haiku-4-5",
    "complexTaskModel": "claude-sonnet-4-6",
    "complexTaskKeywords": ["refactor", "architecture", "security", "self-modify"]
  },
  "toolConfig": {
    "timeoutMs": 30000,
    "retryAttempts": 3,
    "gitHubApiTimeoutStrategy": "flag-quickly"
  },
  "systemPrompt": {
    "greetingBehavior": "auto-start",
    "autonomousStartupChecks": true,
    "checkTasksJsonFirst": true,
    "checkGitHistoryFirst": true,
    "checkAuditLogsFirst": true
  }
}
```

### Example 2: Team Shared Deployment

For a shared team instance, you might want stricter rate limits:

```json
{
  "rateLimits": {
    "selfModifyPerSession": 5,
    "selfModifyPerDay": 20,
    "approvalTimeoutMinutes": 15,
    "commandTimeoutMs": 60000
  },
  "guardrails": {
    "rules": [
      "Prefer deterministic tool use with minimal steps",
      "Require explicit approval for any breaking changes",
      "Use only provided tools and avoid speculative or unrelated changes",
      "If blocked, escalate to team lead instead of guessing"
    ]
  }
}
```

## Troubleshooting

### Configuration not loading?

1. Check that USER_CONFIG_KV binding is defined in `wrangler.toml`
2. Check that the KV namespace has the key `"user-configuration"`
3. Check Cloudflare Worker logs for errors
4. Verify the JSON is valid (use an online JSON validator)

### Changes not taking effect?

Configuration is cached for 5 minutes. Either:
- Wait 5 minutes for the cache to expire
- Redeploy the Worker with `wrangler deploy`
- Restart the Durable Object

### Performance concerns?

- Configuration is fetched once per Durable Object instance
- Results are cached for 5 minutes
- Typical KV read time: <10ms
- No performance impact on message processing

## Migration from Code-Based Configuration

If you were using an earlier version of Blob that had configuration in AGENT.md:

1. Review `AGENT.md` for any user-specific information
2. Create a custom `config-custom.json` with those values
3. Upload to KV with key `"user-configuration"`
4. Redeploy

The code now loads from KV first, so your code-based configuration will be completely replaced by KV values.

## Next Steps

- Read `src/kv-schema.ts` for the full configuration schema
- See `config-template.json` for a complete example
- Check `AGENT.md` for agent behavior and capabilities
