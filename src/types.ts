export interface Env {
  AGENT_DO: DurableObjectNamespace;
  REPO_STORE: R2Bucket;
  SANDBOX?: Fetcher;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  LOGS_CHANNEL?: string;
  GITHUB_TOKEN?: string;
  GITHUB_USERNAME?: string;
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
