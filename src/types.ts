export interface Env {
  AGENT_DO: DurableObjectNamespace;
  REPO_STORE: R2Bucket;
  SANDBOX?: Fetcher;
  ANTHROPIC_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  LOGS_CHANNEL?: string;
  GITHUB_TOKEN?: string;
  GITHUB_USERNAME?: string;
  /** Cloudflare account ID – required to route requests through AI Gateway */
  CF_ACCOUNT_ID?: string;
  /** AI Gateway name/slug created in the Cloudflare dashboard */
  CF_AI_GATEWAY_ID?: string;
  /**
   * AI provider slug used in the gateway URL (default: "anthropic").
   * Other supported values: "openai", "google-ai-studio", "workers-ai", etc.
   * See https://developers.cloudflare.com/ai-gateway/usage/providers/
   */
  CF_AI_PROVIDER?: string;
}

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string | unknown[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: Array<{ type: "text"; text: string }>;
}

export interface AgentState {
  threadTs: string;
  sessionId: string;
  stepCount: number;
  messages: ConversationMessage[];
  pendingApprovalCommand?: string;
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  reaction?: string;
  item?: { ts?: string; channel?: string };
}
