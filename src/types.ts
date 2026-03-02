import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  AGENT_DO?: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;

  // Workers AI binding - no config needed
  AI?: {
    run: (
      model: string,
      inputs: { messages: Array<{ role: string; content: string }>; max_tokens: number }
    ) => Promise<{ response?: string }>;
  };

  REPO_STORE?: R2Bucket;
  GITHUB_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  SLACK_BOT_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ACCOUNT_ID?: string;
}
