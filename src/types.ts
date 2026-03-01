export interface Env {
  AGENT_DO?: DurableObjectNamespace;
  
  // DO namespace binding (so other code can call the Sandbox DO)
  SANDBOX_DO?: DurableObjectNamespace;
  
  // Container fetcher binding (from [[containers]] name="sandbox_v2")
  sandbox_v2?: Fetcher;
  
  REPO_STORE?: R2Bucket;
  GITHUB_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  SLACK_BOT_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ACCOUNT_ID?: string;
}