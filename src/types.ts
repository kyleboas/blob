export interface Env {
  AGENT_DO: DurableObjectNamespace;
  REPO_STORE: R2Bucket;
  SANDBOX?: Fetcher;
  ANTHROPIC_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
}

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
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
  user?: string;
  bot_id?: string;
  subtype?: string;
  channel?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  reaction?: string;
}
