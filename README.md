# Blob - Autonomous Coding Agent

Fully autonomous agent that works on GitHub repositories.

## Setup

```bash
wrangler kv:namespace create CONFIG
# Copy the ID into wrangler.toml

wrangler secret put GITHUB_TOKEN
wrangler secret put AI_GATEWAY_TOKEN  
wrangler secret put AI_GATEWAY_BASE_URL

# Deploy the main worker
wrangler deploy

# Deploy the sandbox worker
wrangler deploy --config wrangler.sandbox.toml
```

## API

```bash
# List repos
curl https://blob.your-account.workers.dev/repos

# Add repo
curl -X POST https://blob.your-account.workers.dev/repos -d '{"repo":"owner/repo"}'

# Set goals
curl -X POST https://blob.your-account.workers.dev/repos/owner/repo/goals -d '{"goals":["fix bugs"]}'

# Run now
curl -X POST https://blob.your-account.workers.dev/run
```

Runs automatically every 5 minutes.
