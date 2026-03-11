import { logEvent } from "./observability";
import { callLLM } from "./llm";
import { WORKERS_AI_GATEWAY_MODEL } from "./models";
import type { Env } from "./types";
export interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "chat";
  needsSandbox?: boolean;
  schedule?: string;
  task?: string;
  search?: string;
}

/**
 * Heuristic pre-check: return true if the message almost certainly needs
 * the sandbox (real-time data, code tasks, file operations, etc.).
 * This runs before the LLM call and acts as a fast-path + safe fallback.
 */
function likelyNeedsSandbox(text: string): boolean {
  const lower = text.toLowerCase();

  // Real-time / live data requests
  if (/\b(weather|forecast|temperature|rain|snow|wind|humidity|uv index)\b/.test(lower)) return true;
  if (/\b(current|live|real.?time|latest|today'?s?|right now|at the moment)\b/.test(lower) &&
      /\b(news|price|stock|score|result|status|time|date|rate|update)\b/.test(lower)) return true;
  if (/\b(what time is it|what'?s? the time|current time|current date|today'?s? date)\b/.test(lower)) return true;
  if (/\b(stock price|share price|crypto|bitcoin|exchange rate|currency)\b/.test(lower)) return true;
  if (/\b(news|headlines|breaking)\b/.test(lower)) return true;
  if (/\b(score|fixture|match|game|kick.?off|when do .+ play)\b/.test(lower)) return true;
  if (/\b(check|ping|status of|is .+ (up|down|working|live))\b/.test(lower)) return true;

  // Code / repo tasks
  if (/\b(run|execute|test|build|deploy|lint|compile|install|npm|yarn|pnpm|git|commit|push|pull request|pr)\b/.test(lower)) return true;
  if (/\b(fix|debug|refactor|write|create|add|update|delete|remove)\b.{0,40}\b(file|function|class|component|test|code|script|bug|error|issue)\b/.test(lower)) return true;
  if (/\b(read|open|show|cat|ls|list)\b.{0,30}\b(file|directory|folder|repo|codebase)\b/.test(lower)) return true;

  // Web / search
  if (/\b(search|look up|find|google|browse|visit|open)\b.{0,40}\b(web|internet|site|url|link|page)\b/.test(lower)) return true;
  if (/\bhttps?:\/\//.test(lower)) return true;

  return false;
}

export async function classifyIntent(text: string, env: Env): Promise<IntentResult> {
  // Fast-path: if heuristic is confident, skip LLM call for needsSandbox
  const heuristicSandbox = likelyNeedsSandbox(text);

  const prompt = `You are an intent classifier for a Slack bot. Analyze the message and extract the user's intent.

Possible intents:
- "list_cron": User wants to see their scheduled cron jobs (e.g., "show my jobs", "what tasks do I have", "list my cron jobs")
- "add_cron": User wants to create a new scheduled task (e.g., "remind me every 5 minutes to check email", "add a job to run tests daily")
- "delete_cron": User wants to remove a scheduled task (e.g., "delete the email reminder", "remove my test job")
- "chat": General conversation, not a specific command

For "chat" intent, also determine:
- needsSandbox: true if the message requires executing tools — this includes:
  (a) working with code in the repository (fix bugs, run tests, read files, create PRs, etc.)
  (b) fetching ANY external or real-time information the LLM cannot know from training data (weather, current time/date, stock prices, sports scores, news, website status, etc.)
  (c) any task that requires browsing the web, running commands, or calling external APIs
  Set needsSandbox to false ONLY if the message can be fully and accurately answered from the LLM's own static training knowledge without any tool use (e.g., "hello", "thanks", "what is a REST API", "explain how promises work", "how are you").
  When in doubt, set needsSandbox to true.

For "add_cron", extract:
- schedule: The time pattern (e.g., "every 5 minutes", "daily at 9am", "hourly")
- task: What to do (e.g., "check email", "run tests", "backup database")

For "delete_cron", extract:
- search: Keywords to find the job to delete (e.g., "email", "test", "backup")

Respond with ONLY a JSON object in this format:
{"intent": "list_cron|add_cron|delete_cron|chat", "needsSandbox": true|false, "schedule": "...", "task": "...", "search": "..."}

Message: "${text}"`;

  try {
    const response = await callLLM([{ role: "user", content: prompt }], env, { maxTokens: 200, model: WORKERS_AI_GATEWAY_MODEL });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]) as IntentResult;
      // If heuristic says sandbox is needed, override the LLM result
      if (heuristicSandbox && result.intent === "chat") {
        result.needsSandbox = true;
      }
      return result;
    }
  } catch (err) {
    logEvent(env, "slack_ingest", "intent_classify_failed", { error: String(err) });
  }

  // Fallback: use heuristic result rather than always returning false
  return { intent: "chat", needsSandbox: heuristicSandbox };
}

export async function classifyNeedsSandbox(text: string, env: Env): Promise<boolean> {
  const result = await classifyIntent(text, env);
  return result.intent === "chat" && result.needsSandbox === true;
}
