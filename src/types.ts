// types.ts - Two-worker setup with service binding

export interface Env {
  // Main agent DO
  AGENT_DO: DurableObjectNamespace;
  
  // Service binding to sandbox worker (contains the container)
  SANDBOX: Fetcher;
  
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