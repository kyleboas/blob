import { logEvent } from "./observability";
import { callLLM } from "./llm";
import type { Env } from "./types";

export interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "chat";
  needsSandbox?: boolean;
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
- needsSandbox: true if the message requires executing tools — this includes working with code in the repository (e.g., "fix the bug in auth.ts", "run the tests") OR fetching external information that the LLM doesn't inherently know (e.g., "what's the weather", "what time is it", "when do Manchester City play", "check the status of example.com", "what's the latest news"). false ONLY if the message can be fully answered from the LLM's own knowledge without any tool use (e.g., "hello", "thanks", "what is a REST API", "explain how promises work", "how are you").

For "add_cron", extract:
- schedule: The time pattern (e.g., "every 5 minutes", "daily at 9am", "hourly")
- task: What to do (e.g., "check email", "run tests", "backup database")

For "delete_cron", extract:
- search: Keywords to find the job to delete (e.g., "email", "test", "backup")

Respond with ONLY a JSON object in this format:
{"intent": "list_cron|add_cron|delete_cron|chat", "needsSandbox": true|false, "schedule": "...", "task": "...", "search": "..."}

Message: "${text}"`;

  try {
    const response = await callLLM([{ role: "user", content: prompt }], env, { maxTokens: 200 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as IntentResult;
    }
  } catch (err) {
    logEvent(env, "slack_ingest", "intent_classify_failed", { error: String(err) });
  }

  return { intent: "chat", needsSandbox: false };
}

export async function classifyNeedsSandbox(text: string, env: Env): Promise<boolean> {
  const result = await classifyIntent(text, env);
  return result.intent === "chat" && result.needsSandbox === true;
}
