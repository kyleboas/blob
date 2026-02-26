/**
 * User configuration schema for Cloudflare KV storage.
 * All user-specific information (profile, preferences, tasks, guardrails) lives here,
 * separate from the codebase to enable distribution and customization.
 */

export interface UserProfile {
  name: string;
  githubUsername: string;
  primaryRepository?: string;
  description?: string;
}

export interface ProjectConfig {
  name: string;
  goal?: string;
  status?: string;
  defaultBehavior?: string;
}

export interface MessageFormatting {
  maxCharacters: number;
  includeEmojis: boolean;
  markdownStyle: "full" | "code-blocks-only" | "plain";
}

export interface ToolConfig {
  timeoutMs: number;
  retryAttempts: number;
  gitHubApiTimeoutStrategy?: "flag-quickly" | "retry" | "fallback";
}

export interface GuardrailConfig {
  executionMode: string;
  preferDeterministic: boolean;
  onBlockedBehavior: "report-and-stop" | "retry" | "escalate";
  allowSpeculativeChanges: boolean;
  rules: string[];
}

export interface SystemPromptConfig {
  greetingBehavior: "prompt-for-direction" | "check-work" | "auto-start";
  autonomousStartupChecks: boolean;
  checkTasksJsonFirst: boolean;
  checkGitHistoryFirst: boolean;
  checkAuditLogsFirst: boolean;
}

export interface RateLimitConfig {
  selfModifyPerSession: number;
  selfModifyPerDay: number;
  approvalTimeoutMinutes: number;
  commandTimeoutMs: number;
}

export interface ModelRoutingConfig {
  defaultModel: string;
  complexTaskModel: string;
  complexTaskKeywords: string[];
}

export interface UserConfiguration {
  version: "1.0";
  createdAt: string;
  updatedAt: string;
  userId?: string;
  user: UserProfile;
  project?: ProjectConfig;
  messageFormatting: MessageFormatting;
  toolConfig: ToolConfig;
  guardrails: GuardrailConfig;
  systemPrompt: SystemPromptConfig;
  rateLimits: RateLimitConfig;
  modelRouting: ModelRoutingConfig;
}

/**
 * Default configuration with sensible fallbacks.
 * Used when KV is unavailable or configuration is incomplete.
 */
export const DEFAULT_CONFIGURATION: UserConfiguration = {
  version: "1.0",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  user: {
    name: "Agent",
    githubUsername: "agent",
  },
  messageFormatting: {
    maxCharacters: 255,
    includeEmojis: false,
    markdownStyle: "code-blocks-only",
  },
  toolConfig: {
    timeoutMs: 30000,
    retryAttempts: 3,
    gitHubApiTimeoutStrategy: "flag-quickly",
  },
  guardrails: {
    executionMode: "follow the approved plan and complete the requested task only",
    preferDeterministic: true,
    onBlockedBehavior: "report-and-stop",
    allowSpeculativeChanges: false,
    rules: [
      "Prefer deterministic tool use with minimal steps",
      "Use only provided tools and avoid speculative or unrelated changes",
      "If blocked, report the blocker clearly and stop instead of guessing",
    ],
  },
  systemPrompt: {
    greetingBehavior: "auto-start",
    autonomousStartupChecks: true,
    checkTasksJsonFirst: true,
    checkGitHistoryFirst: true,
    checkAuditLogsFirst: true,
  },
  rateLimits: {
    selfModifyPerSession: 3,
    selfModifyPerDay: 10,
    approvalTimeoutMinutes: 30,
    commandTimeoutMs: 30000,
  },
  modelRouting: {
    defaultModel: "claude-haiku-4-5",
    complexTaskModel: "claude-sonnet-4-5",
    complexTaskKeywords: ["refactor", "architecture", "security", "self-modify"],
  },
};
