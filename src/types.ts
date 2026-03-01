// types.ts - Clean Env interface for one-worker + Sandbox DO proxy

export interface Env {
  // Durable Objects (required - Wrangler always provides these)
  AGENT_DO: DurableObjectNamespace;
  SANDBOX_DO: DurableObjectNamespace;

  // Container binding(s). Naming can vary by wrangler/container config.
  sandbox?: { fetch: typeof fetch };
  Sandbox?: { fetch: typeof fetch };
  SANDBOX?: { fetch: typeof fetch };
  BLOB_SANDBOX?: { fetch: typeof fetch };

  // R2 Bucket
  REPO_STORE: R2Bucket;

  // Workers AI binding
  AI?: {
    run: (
      model: string,
      inputs: { messages: Array<{ role: string; content: string }>; max_tokens: number }
    ) => Promise<{ response?: string }>;
  };

  // Secrets / vars
  GITHUB_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  SLACK_BOT_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ACCOUNT_ID?: string;
}
