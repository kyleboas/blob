// types.ts - Service binding interface for sandbox worker

export interface SandboxService {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

export interface Env {
  // Main agent DO
  AGENT_DO: DurableObjectNamespace;
  
  // Service binding to sandbox worker (WorkerEntrypoint methods)
  SANDBOX: SandboxService;
  
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