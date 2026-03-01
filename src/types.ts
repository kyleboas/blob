export interface Env {
  AGENT_DO?: DurableObjectNamespace;
  SANDBOX?: Fetcher;
  REPO_STORE?: R2Bucket;
  GITHUB_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  SLACK_BOT_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ACCOUNT_ID?: string;
}