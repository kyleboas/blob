// types.ts - Service binding interface for sandbox worker

export interface SandboxService {
  start?(): Promise<void>;
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

export interface Env {
  AGENT_DO: DurableObjectNamespace;
  SANDBOX: SandboxService;
  REPO_STORE: R2Bucket;
  PI_MEMORY?: KVNamespace;
  PI_VECTORS?: VectorizeIndex;

  AI?: {
    run: (
      model: string,
      inputs:
        | { messages: Array<{ role: string; content: string }>; max_tokens: number }
        | { text: string | string[] }
    ) => Promise<{ response?: string } | { data: number[][] }>;
  };

  GITHUB_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_SUMMARY_CHANNEL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ACCOUNT_ID?: string;
}
