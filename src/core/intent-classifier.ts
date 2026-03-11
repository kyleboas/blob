import { logEvent } from "./observability";
import { callLLM } from "./llm";
import { WORKERS_AI_GATEWAY_MODEL } from "./models";
import type { Env } from "./types";
export interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "chat";
  needsSandbox?: boolean;
  /** True when the task only needs bash/curl (no repo clone needed). */
  externalDataOnly?: boolean;
  schedule?: string;
  task?: string;
  search?: string;
}



export async function classifyIntent(text: string, env: Env): Promise<IntentResult> {


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

      return result;
    }
  } catch (err) {
    logEvent(env, "slack_ingest", "intent_classify_failed", { error: String(err) });
  }

  // Fallback: LLM call failed, default to needsSandbox: true (fail safe)
  return {
    intent: "chat",
    needsSandbox: true,
    externalDataOnly: false, // Assume full sandbox needed if LLM fails
  };
}

export async function classifyNeedsSandbox(text: string, env: Env): Promise<boolean> {
  const result = await classifyIntent(text, env);
  return result.intent === "chat" && result.needsSandbox === true;
}
