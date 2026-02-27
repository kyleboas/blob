/**
 * Backwards-compatible hardcoded defaults.
 * When user configuration is not available, these are used.
 */
export const MAX_STEPS = 25;
export const COMMAND_TIMEOUT = 30;
export const MEMORY_LIMIT_MB = 512;
export const SELF_MODIFY_LIMIT_SESSION = 3;
export const SELF_MODIFY_LIMIT_DAY = 10;
export const APPROVAL_TIMEOUT_MINUTES = 30;
export const CONVERSATION_TIMEOUT_MINUTES = 30;
export const COMPACTION_TOKEN_THRESHOLD = 20_000;
export const SESSION_SUMMARY_RECENT_COUNT = 5;
export const THINKING_MESSAGE_DELAY_MS = 2_000;

// Cloudflare AI Gateway models (external API calls)
export const MODEL_ROUTER = "@cf/ibm-granite/granite-4.0-h-micro";
export const MODEL_CHAT = "@cf/zai-org/glm-4.7-flash";
export const MODEL_SIMPLE = "@cf/qwen/qwen3-30b-a3b-fp8";
export const MODEL_COMPLEX = "claude-sonnet-4-6";
export const MODEL_PLANNER_SIMPLE = MODEL_SIMPLE;
export const MODEL_PLANNER_COMPLEX = MODEL_COMPLEX;
export const MODEL_EXECUTION_SIMPLE = "@cf/qwen/qwen3-30b-a3b-fp8";
export const MODEL_EXECUTION_COMPLEX = "@cf/qwen/qwen3-30b-a3b-fp8";

// Workers AI models (local, fast, no external API call)
export const WORKERS_AI_CHAT = "@cf/meta/llama-3.1-8b-instruct";
export const WORKERS_AI_FAST = "@cf/meta/llama-3.1-8b-instruct";

// Backwards-compatible aliases for older two-tier references.
export const MODEL_ROUTINE = MODEL_SIMPLE;

export const PROTECTED_FILES = [
  "agent.py",
  "sandbox.py",
  "approval.py",
  "safety.py",
  "config.py",
  "slack_bot.py"
] as const;

export const TOOL_OUTPUT_MAX_CHARS = 8_000;
export const TOOL_RETRY_MAX = 2;
export const TOOL_RETRY_BACKOFF_BASE_MS = 1_500;
export const BACKGROUND_TASK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between background task checks
export const PLANNER_AUDIT_MAX_ATTEMPTS = 3;

export const LLM_OVERLOAD_RETRY_MAX = 4;
export const LLM_OVERLOAD_RETRY_BASE_MS = 5_000;
export const LLM_REQUEST_TIMEOUT_MS = 120_000;
export const LLM_MAX_TOKENS = 4096;
export const LLM_MAX_TOKENS_CHAT = 4096;
export const LLM_MAX_TOKENS_SIMPLE = 4096;
export const LLM_MAX_TOKENS_COMPLEX = 8192;
export const LLM_MAX_TOKENS_ROUTER = 16;

/**
 * Factory functions for configuration-driven values.
 * These accept UserConfiguration from KV and return configuration-specific values.
 */
import type { UserConfiguration } from "./kv-schema";

export function createConfigFromUserSettings(userConfig: UserConfiguration) {
  return {
    maxSteps: MAX_STEPS, // Could be extended to support per-user limits
    commandTimeoutSeconds: COMMAND_TIMEOUT,
    selfModifyLimitPerSession: userConfig.rateLimits.selfModifyPerSession,
    selfModifyLimitPerDay: userConfig.rateLimits.selfModifyPerDay,
    approvalTimeoutMinutes: userConfig.rateLimits.approvalTimeoutMinutes,
    conversationTimeoutMinutes: CONVERSATION_TIMEOUT_MINUTES,
    modelForComplexTask: userConfig.modelRouting.complexTaskModel,
    modelForRoutineTask: userConfig.modelRouting.defaultModel,
    complexTaskKeywords: userConfig.modelRouting.complexTaskKeywords,
    toolTimeoutMs: userConfig.toolConfig.timeoutMs,
    toolRetryAttempts: userConfig.toolConfig.retryAttempts,
  };
}

/**
 * Build system guardrails string from user configuration.
 */
export function buildExecutionGuardrails(userConfig: UserConfiguration): string {
  const guardrails = [
    `Execution mode: ${userConfig.guardrails.executionMode}`,
    ...userConfig.guardrails.rules,
  ];
  return guardrails.join(" ");
}
