import { PiAgent } from "../agent/pi-agent";
import { callLLM } from "../core/llm";
import { getLearnedMemoryStatus, getVectorizeMemoryStatus } from "../core/memory-system";
import { logEvent } from "../core/observability";
import { getRepos } from "../core/storage";
import type { Env } from "../core/types";
import { withDOAuth } from "../core/do-auth";
import { runOptimizationCycle, loadConfig } from "../self-improve/index";
import { embedText } from "../core/memory-system";
import { probeSandbox as probeSandboxHealth } from "./sandbox";
export { classifyIntent } from "../core/intent-classifier";

type Verbosity = "minimal" | "verbose";

function globalDO(env: Env): DurableObjectStub | null {
  return env.AGENT_DO ? env.AGENT_DO.get(env.AGENT_DO.idFromName("blob")) : null;
}

export function normalizeCommandText(text: string): string {
  return text.replace(/^(?:\s*<@[^>]+>\s*)+/, "").trim().replace(/\s+/g, " ");
}

export function getExactKeywordCommand(text: string): "settings" | "status" | "selftest" | "set minimal" | "set verbose" | "secrets" | "heartbeat config" | "self-improve" | "jobs" | "dryrun" | null {
  const normalized = normalizeCommandText(text).toLowerCase();
  if (["settings", "status", "selftest", "set minimal", "set verbose", "secrets", "heartbeat config", "self-improve", "jobs", "dryrun"].includes(normalized)) {
    return normalized as ReturnType<typeof getExactKeywordCommand>;
  }
  return null;
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

async function handleSelfImproveCommand(env: Env): Promise<{ handled: boolean; response: string }> {
  try {
    const config = await loadConfig(env.REPO_STORE);
    const result = await runOptimizationCycle(env);
    return {
      handled: true,
      response: `Self-improve cycle complete (currently on v${config.version}):\n${result}`,
    };
  } catch (err) {
    logEvent(env, "slack_ingest", "self_improve_manual_failed", { error: String(err) });
    return {
      handled: true,
      response: `Self-improve failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runDryRunHealthChecks(env: Env): Promise<{ r2: boolean; sandbox: boolean; vectorize: boolean; do: boolean; memory: boolean; details: string[] }> {
  const timeoutMs = 5000;
  const details: string[] = [];

  const withTimeout = <T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs);
      factory().then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  };

  const r2Check = withTimeout(async () => {
    await env.REPO_STORE.head("config/runtime-controls.json");
    return true;
  }, timeoutMs).catch((err) => { details.push(`R2: ${err instanceof Error ? err.message : String(err)}`); return false; });

  const sandboxCheck = withTimeout(() => probeSandboxHealth(env), timeoutMs).catch((err) => { details.push(`Sandbox: ${err instanceof Error ? err.message : String(err)}`); return false; });

  const vectorizeCheck = withTimeout(async () => {
    if (!env.PI_VECTORS || !env.AI) {
      details.push("Vectorize: PI_VECTORS or AI binding missing");
      return false;
    }
    const vector = await embedText(env, "blob dryrun healthcheck");
    if (!vector?.length) {
      details.push("Vectorize: embedding failed");
      return false;
    }
    const result = await env.PI_VECTORS.query(vector, { topK: 1 });
    if (!Array.isArray(result.matches)) {
      details.push("Vectorize: query failed");
      return false;
    }
    return true;
  }, timeoutMs).catch((err) => { details.push(`Vectorize: ${err instanceof Error ? err.message : String(err)}`); return false; });

  const doCheck = withTimeout(async () => {
    const doStub = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
    const response = await doStub.fetch("http://do/heartbeat/status", withDOAuth(env, { method: "GET" }));
    return response.ok;
  }, timeoutMs).catch((err) => { details.push(`Durable Object: ${err instanceof Error ? err.message : String(err)}`); return false; });

  const memoryCheck = withTimeout(async () => {
    const status = await getLearnedMemoryStatus(env);
    if (!status.lastFlushAt) {
      details.push("Memory: no flush history (may be normal for fresh install)");
      return true; // Not a failure, just informational
    }
    return true;
  }, timeoutMs).catch((err) => { details.push(`Memory: ${err instanceof Error ? err.message : String(err)}`); return false; });

  const [r2, sandbox, vectorize, doHealth, memory] = await Promise.all([r2Check, sandboxCheck, vectorizeCheck, doCheck, memoryCheck]);

  return { r2, sandbox, vectorize, do: doHealth, memory, details };
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
      response: `Status: ready. Current verbosity is ${verbosity}. Heartbeat last run: ${heartbeat.lastCompletedAt ?? "never"}. Next heartbeat: ${heartbeat.nextAlarmAt ?? "unknown"}. Heartbeat jobs queued/paused/running: ${heartbeat.jobs.queued}/${heartbeat.jobs.paused}/${heartbeat.jobs.running}. Heartbeat call budget remaining in last cycle: ${heartbeat.callsRemaining ?? "unknown"}. Learned memory last flush: ${flushText}. Learned entries in last flush: ${learned.lastFlushCount}. Vectorize upsert: ${upsert} at ${vectorize.lastUpsertAt ?? "never"}. Vectorize last query count: ${vectorize.lastQueryCount} at ${vectorize.lastQueryAt ?? "never"}.\n\n💡 Run \`dryrun\` to test infrastructure without LLMs.`,
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
  if (keywordCommand === "self-improve") {
    return await handleSelfImproveCommand(env);
  }
  if (keywordCommand === "jobs") {
    const do_ = globalDO(env);
    if (!do_) return { handled: true, response: "No jobs found." };
    const res = await do_.fetch("http://do/jobs", withDOAuth(env));
    const { jobs } = await res.json() as { jobs: Array<{ id: string; status: string; created_at: number; updated_at: number; current_step: string; tool_history: string; token_usage: number; model_call_count: number; estimated_calls: number; sandbox_id: string | null }> };
    if (jobs.length === 0) {
      return { handled: true, response: "No jobs found." };
    }
    const lines = jobs.slice(-10).map((job) => {
      const age = Math.round((Date.now() - job.created_at) / 60000);
      const ageText = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      const step = job.current_step ? ` — ${job.current_step.slice(0, 60)}` : "";
      let toolSummary = "";
      try {
        const history = JSON.parse(job.tool_history) as Array<{ tool: string; ok: boolean }>;
        if (history.length > 0) {
          const counts = history.reduce((acc: Record<string, number>, e) => { acc[e.tool] = (acc[e.tool] ?? 0) + 1; return acc; }, {});
          toolSummary = ` [${Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(", ")}]`;
        }
      } catch (_e) {
        toolSummary = "";
      }
      return `• \`${job.id.slice(0, 8)}\` ${job.status} ${ageText} — ${job.token_usage} tokens, ${job.model_call_count}/${job.estimated_calls} calls${toolSummary}${step}`;
    });
    return { handled: true, response: `Recent jobs (last ${lines.length}):\n${lines.join("\n")}` };
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

  if (keywordCommand === "dryrun") {
    const checks = await runDryRunHealthChecks(env);
    const passing = Object.values(checks).filter((v) => typeof v === "boolean" && v).length;
    const total = 5;
    const status = passing === total ? "✅ All systems operational" : passing === 0 ? "❌ All systems failing" : `⚠️ ${passing}/${total} systems passing`;

    const lines = [
      status,
      "",
      `• R2 Storage: ${checks.r2 ? "✅" : "❌"}`,
      `• Sandbox: ${checks.sandbox ? "✅" : "❌"}`,
      `• Vectorize: ${checks.vectorize ? "✅" : "❌"}`,
      `• Durable Object: ${checks.do ? "✅" : "❌"}`,
      `• Memory System: ${checks.memory ? "✅" : "❌"}`,
    ];
    if (checks.details.length > 0) {
      lines.push("", "Details:");
      lines.push(...checks.details.map((d) => `  ${d}`));
    }
    return { handled: true, response: lines.join("\n") };
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
