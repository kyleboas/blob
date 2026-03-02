import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // Durable Objects
  AGENT_DO: DurableObjectNamespace;
  SANDBOX_DO: DurableObjectNamespace<Sandbox>;

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
