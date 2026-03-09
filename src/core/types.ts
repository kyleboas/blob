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

  CRON_FAIL_THRESHOLD?: string;
  CRON_STALL_MULTIPLIER?: string;
  SECRET_PATTERNS?: string;
  SANDBOX_IDLE_TIMEOUT_MS?: string;
  SANDBOX_KEEP_ON_FAILURE?: string;
  TOOL_MAX_FILE_BYTES?: string;
  BASH_TIMEOUT_MS?: string;
  BASH_MAX_OUTPUT_BYTES?: string;
  JOB_MAX_INPUT_TOKENS?: string;
  JOB_MAX_OUTPUT_TOKENS?: string;
  HEARTBEAT_MODEL_CALL_LIMIT?: string;
  HEARTBEAT_INTERVAL_MS?: string;
  DAILY_TOKEN_CEILING?: string;
  MAX_CONSECUTIVE_TOOL_FAILURES?: string;
  LLM_MODEL?: string;
  VERIFY_COMMAND?: string;
  VERIFY_MAX_ATTEMPTS?: string;

  AUTORESEARCH_REPO?: string;
  AUTORESEARCH_BRANCH?: string;
}
