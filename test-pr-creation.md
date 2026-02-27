# GitHub API Authentication in CCR Mode - Test Results

## Summary

Branch push: **WORKS** via local git proxy → Anthropic session ingress → GitHub

PR creation: **BLOCKED** - GitHub REST API is inaccessible from CCR environment

## Network Architecture in CCR Mode

```
CCR Container
├── Local git proxy (127.0.0.1:22862)  ← git push/pull works
│   └── Anthropic session ingress (api.anthropic.com)
│       └── GitHub (git protocol only)
│
└── Egress proxy (21.0.0.115:15004)   ← REST API blocked
    └── Allowed hosts only:
        - api.anthropic.com
        - sentry.io
        - statsig.anthropic.com
        - statsig.com
        (GitHub NOT in allowlist)
```

## Root Cause

The `GITHUB_TOKEN` from Cloudflare Worker secrets is injected into the
Cloudflare Sandbox via `/workspace/.blob-env` by `injectSecretsIntoSandbox()`.
But in CCR mode, Claude Code runs in Anthropic's container (not the Cloudflare
Sandbox), so:

1. `/workspace/.blob-env` is never written to the CCR container
2. `GITHUB_TOKEN` is not in the CCR environment
3. Direct GitHub API calls are blocked by the egress proxy

## What Works

- `git push` via local git proxy (uses session JWT for auth)
- Commit signing (via codesign MCP server)
- Read access to the repo

## What Doesn't Work

- `python github_tools.py create-pr` (no GITHUB_TOKEN)
- Direct `curl https://api.github.com/...` (blocked by egress)
- WebFetch to GitHub (also goes through egress proxy)

## Fix Options

1. **Session ingress GitHub REST API proxy**: Add a `/github_rest/` endpoint
   to the Anthropic session ingress that proxies REST API calls to GitHub
   using the session's GitHub token.

2. **Inject token via CCR startup**: When the blob-agent creates a CCR
   session, include GITHUB_TOKEN in the environment context passed to the
   environment-manager via stdin (`auth` field with `type: "github_app"`).

3. **Worker-side PR creation**: Add a mechanism for CCR sessions to request
   PR creation from the blob-agent Worker side (which has GITHUB_TOKEN).
   Could be done via a special event posted to the session ingress.
