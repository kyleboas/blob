export const MAX_STEPS = 25;
export const COMMAND_TIMEOUT = 30;
export const MEMORY_LIMIT_MB = 512;
export const SELF_MODIFY_LIMIT_SESSION = 3;
export const SELF_MODIFY_LIMIT_DAY = 10;
export const APPROVAL_TIMEOUT_MINUTES = 30;
export const CONVERSATION_TIMEOUT_MINUTES = 30;
export const COMPACTION_TOKEN_THRESHOLD = 20_000;
export const SESSION_SUMMARY_RECENT_COUNT = 5;
export const THINKING_MESSAGE_DELAY_MS = 6_000;

export const MODEL_ROUTER = "@cf/ibm-granite/granite-4.0-h-micro";
export const MODEL_CHAT = "claude-haiku-4-5";
export const MODEL_SIMPLE = "@cf/qwen/qwen2.5-coder-32b-instruct";
export const MODEL_COMPLEX = "claude-sonnet-4-6";
export const MODEL_PLANNER_SIMPLE = MODEL_SIMPLE;
export const MODEL_PLANNER_COMPLEX = MODEL_COMPLEX;
export const MODEL_EXECUTION_SIMPLE = "@cf/qwen/qwen2.5-coder-7b-instruct";
export const MODEL_EXECUTION_COMPLEX = "@cf/qwen/qwen2.5-coder-14b-instruct";

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
