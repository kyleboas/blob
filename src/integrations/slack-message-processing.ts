import { PiAgent } from "../agent/pi-agent";
import { callLLM } from "../core/llm";
import { createLogRef, logEvent } from "../core/observability";
import { getRuntimeControls } from "../core/runtime-controls";
import { getRepos } from "../core/storage";
import type { Env } from "../core/types";
import { withDOAuth } from "../core/do-auth";
import { classifyIntent, getConversationVerbosity } from "./slack-commands";
import { deriveRoutingKey } from "./slack-routing";
import { addCronJob, deleteCronJob, getCronJobs } from "../jobs/cron";

export type SlackEventPayload = {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type: string;
    text?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
    ts?: string;
    thread_ts?: string;
    channel_type?: string;
  };
};

type Intent = Awaited<ReturnType<typeof classifyIntent>>;

function formatToolLedger(entry: { tool: string; argsSummary?: string; ok: boolean; durationMs: number; error?: string }): string {
  const status = entry.ok ? "ok" : "fail";
  const suffix = entry.argsSummary ? ` [${entry.argsSummary}]` : "";
  const base = `tool ${entry.tool}: ${status} (${entry.durationMs}ms)${suffix}`;
  if (entry.ok || !entry.error) return base;
  return `${base} — ${entry.error.slice(0, 120)}`;
}

async function getConversationHistory(conversationDO: DurableObjectStub | null, env: Env): Promise<Array<{ role: string; content: string }>> {
  if (!conversationDO) return [];
  try {
    const historyRes = await conversationDO.fetch("http://do/messages?limit=20", withDOAuth(env));
    const { messages } = await historyRes.json() as { messages: Array<{ role: string; content: string; timestamp: number }> };
    return messages.map(({ role, content }) => ({ role, content }));
  } catch {
    return [];
  }
}

async function storeExchange(conversationDO: DurableObjectStub | null, user: string, assistant: string, env: Env): Promise<void> {
  if (!conversationDO) return;
  await conversationDO.fetch("http://do/messages", withDOAuth(env, { method: "POST", body: JSON.stringify({ role: "user", content: user }) }));
  await conversationDO.fetch("http://do/messages", withDOAuth(env, { method: "POST", body: JSON.stringify({ role: "assistant", content: assistant }) }));
}

async function getSecretsForInjection(env: Env): Promise<Record<string, string>> {
  if (!env.AGENT_DO) return {};
  try {
    const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
    const res = await do_.fetch("http://do/internal/secrets/injection", withDOAuth(env));
    if (!res.ok) return {};
    const data = await res.json() as { secrets?: Record<string, string> };
    return data.secrets ?? {};
  } catch {
    return {};
  }
}

async function migrateThreadFromChannel(body: SlackEventPayload, env: Env): Promise<void> {
  if (!body.team_id || !body.event?.channel || !body.event.ts || body.event.thread_ts !== body.event.ts || !env.AGENT_DO) return;
  const threadKey = deriveRoutingKey(body);
  const channelKey = `${body.team_id}:${body.event.channel}:channel`;
  const threadDO = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadKey));
  const channelDO = env.AGENT_DO.get(env.AGENT_DO.idFromName(channelKey));
  const channelRes = await channelDO.fetch("http://do/messages?limit=20", withDOAuth(env));
  const { messages } = await channelRes.json() as { messages: Array<{ role: string; content: string; timestamp: number }> };
  await threadDO.fetch("http://do/state/migrate", withDOAuth(env, {
    method: "POST",
    body: JSON.stringify({ channelMessages: messages }),
  }));
}

export async function processIntentOrChat(params: {
  body: SlackEventPayload;
  intent: Intent;
  env: Env;
  conversationDO: DurableObjectStub | null;
  conversationKey: string;
  postToSlack: (channel: string, text: string, env: Env) => Promise<void>;
  formatSlackError: (message: string, logRef: string) => string;
}): Promise<void> {
  const { body, intent, env, conversationDO, conversationKey, postToSlack, formatSlackError } = params;
  const text = body.event?.text;
  const channel = body.event?.channel;
  if (!text || !channel) return;

  await migrateThreadFromChannel(body, env);

  const runtimeControls = await getRuntimeControls(env);
  if (runtimeControls.paused) {
    const reasonText = runtimeControls.reason ? ` Reason: ${runtimeControls.reason}` : "";
    await postToSlack(channel, `⏸️ Blob is currently paused via config/runtime-controls.json.${reasonText}`, env);
    return;
  }

  if (intent.intent === "list_cron") {
    const jobs = await getCronJobs(env);
    if (jobs.length === 0) {
      await postToSlack(channel, "No cron jobs configured. Try: 'remind me every 5 minutes to check email'", env);
    } else {
      const list = jobs.map((job) => `• ${job.schedule}: ${job.task}`).join("\n");
      await postToSlack(channel, `Your cron jobs:\n${list}`, env);
    }
    return;
  }

  if (intent.intent === "add_cron" && intent.schedule && intent.task) {
    const result = await addCronJob(env, intent.schedule, intent.task);
    await postToSlack(channel, result ? `✅ Cron job added: "${intent.schedule}" → "${intent.task}"` : "❌ Failed to add cron job", env);
    return;
  }

  if (intent.intent === "delete_cron") {
    const jobs = await getCronJobs(env);
    if (jobs.length === 0) {
      await postToSlack(channel, "No cron jobs to delete", env);
    } else if (intent.search) {
      const job = jobs.find((entry) => entry.task.toLowerCase().includes(intent.search!.toLowerCase()));
      if (job) {
        await deleteCronJob(env, job.id);
        await postToSlack(channel, `✅ Deleted cron job: ${job.task}`, env);
      } else {
        await postToSlack(channel, `❌ No job matching "${intent.search}" found.`, env);
      }
    } else {
      await postToSlack(channel, "Which job would you like to delete? Try: 'delete my email reminder job'", env);
    }
    return;
  }

  try {
    const conversationHistory = await getConversationHistory(conversationDO, env);
    if (intent.needsSandbox) {
      const repos = await getRepos(env);
      const repo = repos[0] ?? "default";
      const agent = new PiAgent(env, repo);
      const verbosity = await getConversationVerbosity(conversationDO, env);
      const secrets = await getSecretsForInjection(env);
      if (verbosity === "minimal") await postToSlack(channel, "Working…", env);
      const response = await agent.run(text, {
        conversationHistory,
        secrets,
        verbosity,
        onProgress: verbosity === "verbose" ? (msg: string) => postToSlack(channel, msg, env) : undefined,
        onToolLedger: verbosity === "verbose" ? (entry) => postToSlack(channel, formatToolLedger(entry), env) : undefined,
        conversationKey,
      });
      await storeExchange(conversationDO, text, response, env);
      await postToSlack(channel, response, env);
      return;
    }

    const llmMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are a helpful, versatile assistant responding via Slack. Be concise and friendly." },
      ...conversationHistory,
      { role: "user", content: text },
    ];
    const response = await callLLM(llmMessages, env);
    await storeExchange(conversationDO, text, response, env);
    await postToSlack(channel, response, env);
  } catch (err) {
    const logRef = createLogRef("slack");
    logEvent(env, "slack_ingest", "process_message_failed", { error: String(err), channel }, logRef);
    await postToSlack(channel, `❌ ${formatSlackError("Unable to process message.", logRef)}`, env);
  }
}
