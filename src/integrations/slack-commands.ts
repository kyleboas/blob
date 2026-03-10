import { PiAgent } from "../agent/pi-agent";
import { callLLM } from "../core/llm";
import { getLearnedMemoryStatus, getVectorizeMemoryStatus } from "../core/memory-system";
import { logEvent } from "../core/observability";
import { getRepos } from "../core/storage";
import type { Env } from "../core/types";
import { withDOAuth } from "../core/do-auth";

type Verbosity = "minimal" | "verbose";

interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "chat";
  needsSandbox?: boolean;
  schedule?: string;
  task?: string;
  search?: string;
}

function globalDO(env: Env): DurableObjectStub | null {
  return env.AGENT_DO ? env.AGENT_DO.get(env.AGENT_DO.idFromName("blob")) : null;
}

export function getExactKeywordCommand(text: string): "settings" | "status" | "selftest" | "set minimal" | "set verbose" | "secrets" | "heartbeat config" | null {
  const normalized = text.trim().toLowerCase();
  if (["settings", "status", "selftest", "set minimal", "set verbose", "secrets", "heartbeat config"].includes(normalized)) {
    return normalized as ReturnType<typeof getExactKeywordCommand>;
  }
  return null;
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

export const TOKEN_PATTERNS = [
  /^([A-Z][A-Z0-9_]{2,}(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL))\s*[=:]\s*(\S{8,})$/,
];

export async function detectAndStoreSecret(
  text: string,
  channel: string,
  env: Env,
): Promise<{ message: string } | null> {
  const trimmed = text.trim();

  for (const pattern of TOKEN_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const [, name, value] = match;
      if (!name || !value || value.length < 8) continue;
      const do_ = globalDO(env);
      if (!do_) return null;

      await do_.fetch("http://do/secrets", withDOAuth(env, {
        method: "POST",
        body: JSON.stringify({ name, value }),
      }));

      logEvent(env, "slack_ingest", "secret_stored", { name, channel });
      return { message: `Got it — stored ${name} securely. It will be available next time I run a tool.` };
    }
  }

  return null;
}

export async function getConversationVerbosity(conversationDO: DurableObjectStub | null, env?: Env): Promise<Verbosity> {
  if (!conversationDO) return "minimal";
  try {
    const res = await conversationDO.fetch("http://do/settings/verbosity", withDOAuth(env as Env));
    const data = await res.json() as { verbosity?: Verbosity };
    return data.verbosity === "verbose" ? "verbose" : "minimal";
  } catch (err) {
    if (env) logEvent(env, "slack_ingest", "get_verbosity_failed", { error: String(err) });
    return "minimal";
  }
}

async function setConversationVerbosity(conversationDO: DurableObjectStub | null, verbosity: Verbosity, env: Env): Promise<Verbosity> {
  if (!conversationDO) return verbosity;
  try {
    await conversationDO.fetch("http://do/settings/verbosity", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify({ verbosity }),
    }));
    return verbosity;
  } catch (err) {
    logEvent(env, "slack_ingest", "set_verbosity_failed", { error: String(err), verbosity });
    return verbosity;
  }
}

async function getHeartbeatConfig(conversationDO: DurableObjectStub | null, env: Env): Promise<{ intervalMs: number; modelCallLimit: number }> {
  if (!conversationDO) return { intervalMs: 600000, modelCallLimit: 10 };
  try {
    const res = await conversationDO.fetch("http://do/settings/heartbeat", withDOAuth(env));
    const data = await res.json() as { intervalMs?: number; modelCallLimit?: number };
    return { intervalMs: data.intervalMs ?? 600000, modelCallLimit: data.modelCallLimit ?? 10 };
  } catch (err) {
    logEvent(env, "slack_ingest", "get_heartbeat_config_failed", { error: String(err) });
    return { intervalMs: 600000, modelCallLimit: 10 };
  }
}

async function setHeartbeatConfig(conversationDO: DurableObjectStub | null, config: { intervalMs?: number; modelCallLimit?: number }, env: Env): Promise<boolean> {
  if (!conversationDO) return false;
  try {
    const res = await conversationDO.fetch("http://do/settings/heartbeat", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify(config),
    }));
    return res.ok;
  } catch (err) {
    logEvent(env, "slack_ingest", "set_heartbeat_config_failed", { error: String(err) });
    return false;
  }
}

export function mightBeHeartbeatConfig(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.includes("heartbeat")) return false;
  return /interval|every|\bcall|\blimit|\bminut|\bhour|\bsecond|\bfrequenc|configur|\bset\b|change|adjust/.test(t);
}

export async function parseHeartbeatConfig(text: string, env: Env): Promise<{ intervalMs?: number; modelCallLimit?: number } | null> {
  const prompt = `Extract heartbeat configuration changes from this message. Return JSON only.

Fields (only include if explicitly specified):
- intervalMs: interval in milliseconds. Examples: "every 5 minutes"=300000, "hourly"=3600000, "every 30 seconds"=30000, "every 15 minutes"=900000, "every 2 hours"=7200000
- modelCallLimit: max model API calls per heartbeat cycle. Examples: "call limit 5"=5, "10 calls"=10, "limit to 3"=3

Return {} if no config values found.
Message: "${text}"`;
  try {
    const response = await callLLM([{ role: "user", content: prompt }], env, { maxTokens: 100 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { intervalMs?: number; modelCallLimit?: number };
      if (typeof parsed.intervalMs === "number" || typeof parsed.modelCallLimit === "number") {
        return parsed;
      }
    }
  } catch (err) {
    logEvent(env, "slack_ingest", "parse_heartbeat_config_failed", { error: String(err) });
  }
  return null;
}

export function formatHeartbeatInterval(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)} second${Math.round(ms / 1000) === 1 ? "" : "s"}`;
  if (ms < 3600000) {
    const mins = Math.round(ms / 60000);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const hours = Math.round(ms / 3600000);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

async function getHeartbeatStatus(conversationDO: DurableObjectStub | null, env: Env): Promise<{
  nextAlarmAt: string | null;
  lastCompletedAt: string | null;
  callsRemaining: number | null;
  jobs: { queued: number; paused: number; running: number };
}> {
  if (!conversationDO) {
    return { nextAlarmAt: null, lastCompletedAt: null, callsRemaining: null, jobs: { queued: 0, paused: 0, running: 0 } };
  }
  try {
    const res = await conversationDO.fetch("http://do/heartbeat/status", withDOAuth(env));
    const data = await res.json() as {
      nextAlarmAt?: string | null;
      lastCompletedAt?: string | null;
      callsRemaining?: number | null;
      jobs?: { queued?: number; paused?: number; running?: number };
    };
    return {
      nextAlarmAt: data.nextAlarmAt ?? null,
      lastCompletedAt: data.lastCompletedAt ?? null,
      callsRemaining: data.callsRemaining ?? null,
      jobs: {
        queued: data.jobs?.queued ?? 0,
        paused: data.jobs?.paused ?? 0,
        running: data.jobs?.running ?? 0,
      },
    };
  } catch (err) {
    logEvent(env, "slack_ingest", "get_heartbeat_status_failed", { error: String(err) });
    return { nextAlarmAt: null, lastCompletedAt: null, callsRemaining: null, jobs: { queued: 0, paused: 0, running: 0 } };
  }
}

export function isWeatherQuery(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(weather|forecast|temperature|rain(ing|fall)?|snow(ing)?|sunny|cloudy|humid(ity)?)\b/.test(t)
    && /\b(what|how|is it|will it|check|tell me|current|today|tomorrow|tonight|this week|outside)\b/.test(t);
}

export async function handleCommand(
  text: string,
  channel: string,
  env: Env,
  conversationDO: DurableObjectStub | null,
): Promise<{ handled: boolean; response?: string }> {
  const keywordCommand = getExactKeywordCommand(text);
  if (keywordCommand === "settings") {
    const verbosity = await getConversationVerbosity(conversationDO, env);
    const hbConfig = await getHeartbeatConfig(conversationDO, env);
    return {
      handled: true,
      response: `Current mode: ${verbosity}. Use "set minimal" for concise updates or "set verbose" for tool-by-tool updates.\nHeartbeat: every ${formatHeartbeatInterval(hbConfig.intervalMs)}, call limit ${hbConfig.modelCallLimit}. Say e.g. "set heartbeat to every 5 minutes" or "set heartbeat call limit to 5" to change.`,
    };
  }
  if (keywordCommand === "set minimal" || keywordCommand === "set verbose") {
    const verbosity = keywordCommand === "set verbose" ? "verbose" : "minimal";
    await setConversationVerbosity(conversationDO, verbosity, env);
    return { handled: true, response: `Got it — verbosity is now ${verbosity}.` };
  }
  if (keywordCommand === "status") {
    const verbosity = await getConversationVerbosity(conversationDO, env);
    const learned = await getLearnedMemoryStatus(env);
    const vectorize = await getVectorizeMemoryStatus(env);
    const heartbeat = await getHeartbeatStatus(conversationDO, env);
    const flushText = learned.lastFlushAt ? learned.lastFlushAt : "never";
    const upsert = vectorize.lastUpsertOk === null
      ? "unknown"
      : vectorize.lastUpsertOk
        ? "success"
        : `failure (${vectorize.lastUpsertError ?? "error"})`;
    return {
      handled: true,
      response: `Status: ready. Current verbosity is ${verbosity}. Heartbeat last run: ${heartbeat.lastCompletedAt ?? "never"}. Next heartbeat: ${heartbeat.nextAlarmAt ?? "unknown"}. Heartbeat jobs queued/paused/running: ${heartbeat.jobs.queued}/${heartbeat.jobs.paused}/${heartbeat.jobs.running}. Heartbeat call budget remaining in last cycle: ${heartbeat.callsRemaining ?? "unknown"}. Learned memory last flush: ${flushText}. Learned entries in last flush: ${learned.lastFlushCount}. Vectorize upsert: ${upsert} at ${vectorize.lastUpsertAt ?? "never"}. Vectorize last query count: ${vectorize.lastQueryCount} at ${vectorize.lastQueryAt ?? "never"}.`,
    };
  }
  if (keywordCommand === "secrets") {
    const do_ = globalDO(env);
    if (!do_) return { handled: true, response: "No secrets stored." };
    const res = await do_.fetch("http://do/secrets", withDOAuth(env));
    const { secrets } = await res.json() as { secrets: string[] };
    if (secrets.length === 0) {
      return { handled: true, response: "No secrets stored. Paste a token like:\nGOOGLE_TOKEN=your-token-here" };
    }
    return {
      handled: true,
      response: `Stored secrets (names only):\n${secrets.map((s) => `• ${s}`).join("\n")}\n\nTo delete one, type: delete secret MY_TOKEN_NAME`,
    };
  }
  if (keywordCommand === "heartbeat config") {
    const hbConfig = await getHeartbeatConfig(conversationDO, env);
    return {
      handled: true,
      response: `Heartbeat config: interval every ${formatHeartbeatInterval(hbConfig.intervalMs)}, call limit ${hbConfig.modelCallLimit}.\n\nTo change, just say it in plain English:\n• "set heartbeat to every 5 minutes"\n• "set heartbeat call limit to 5"\n• "heartbeat every hour"\n• "reduce heartbeat calls to 3"`,
    };
  }
  if (keywordCommand === "selftest") {
    const repos = await getRepos(env);
    const repo = repos[0] ?? "default";
    const agent = new PiAgent(env, repo);
    const verbosity = await getConversationVerbosity(conversationDO, env);
    const selftestResult = await agent.runSelfTest({
      sandboxId: `selftest-${channel}`,
      verbosity,
      conversationKey: channel,
    });
    return { handled: true, response: verbosity === "minimal" ? `Running self-test…\n${selftestResult}` : selftestResult };
  }

  if (isWeatherQuery(text)) {
    return {
      handled: true,
      response: "I don't have access to real-time data like weather, so I can't check current conditions. Try:\n\t•\tweather.com\n\t•\tGoogle (just search \"Los Angeles weather\")\n\t•\tYour phone's weather app",
    };
  }

  const deleteSecretMatch = text.trim().match(/^delete secret ([A-Z][A-Z0-9_]{2,})$/i);
  if (deleteSecretMatch) {
    const do_ = globalDO(env);
    if (!do_) return { handled: true, response: "No secrets stored." };
    const name = deleteSecretMatch[1].toUpperCase();
    await do_.fetch("http://do/secrets/delete", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify({ name }),
    }));
    return { handled: true, response: `Deleted ${name}.` };
  }

  const secretStore = await detectAndStoreSecret(text, channel, env);
  if (secretStore) return { handled: true, response: secretStore.message };

  if (mightBeHeartbeatConfig(text)) {
    const heartbeatUpdate = await parseHeartbeatConfig(text, env);
    if (heartbeatUpdate && (heartbeatUpdate.intervalMs !== undefined || heartbeatUpdate.modelCallLimit !== undefined)) {
      await setHeartbeatConfig(conversationDO, heartbeatUpdate, env);
      const parts: string[] = [];
      if (heartbeatUpdate.intervalMs !== undefined) {
        parts.push(`interval set to ${formatHeartbeatInterval(heartbeatUpdate.intervalMs)}`);
      }
      if (heartbeatUpdate.modelCallLimit !== undefined) {
        parts.push(`call limit set to ${heartbeatUpdate.modelCallLimit}`);
      }
      return { handled: true, response: `Got it — heartbeat ${parts.join(", ")}.` };
    }
  }

  return { handled: false };
}
