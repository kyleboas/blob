import type { Env } from "../core/types";
import { getRepos } from "../core/storage";
import { callLLM } from "../core/llm";
import { getCronJobs, addCronJob, deleteCronJob } from "../jobs/cron";
import { PiAgent } from "../agent/pi-agent";
import { deriveRoutingKey, verifySlackSignature } from "./slack-routing";
import { createLogRef, logEvent } from "../core/observability";
import { redactSecrets } from "../core/safety";

const inFlightEvents = new Set<string>();

interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "chat";
  needsSandbox?: boolean;
  schedule?: string;
  task?: string;
  search?: string;
}

async function classifyIntent(text: string, env: Env): Promise<IntentResult> {
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
  } catch {
    // fall back to chat
  }

  return { intent: "chat", needsSandbox: false };
}

function formatSlackError(message: string, logRef: string): string {
  return `A system error occurred. Please retry. (ref: ${logRef})\n${message}`;
}

export async function handleSlackEvent(request: Request, env: Env, executionCtx?: ExecutionContext): Promise<Response> {
  try {
    if (env.SLACK_SIGNING_SECRET) {
      const verified = await verifySlackSignature(request, env.SLACK_SIGNING_SECRET);
      if (!verified) {
        logEvent(env, "slack_ingest", "signature_invalid");
        return new Response("Invalid Slack signature", { status: 401 });
      }
    }

    const body = await request.json() as {
      type?: string;
      challenge?: string;
      event_id?: string;
      event?: {
        type: string;
        text?: string;
        channel?: string;
        user?: string;
        bot_id?: string;
        ts?: string;
      };
    };

    if (body.type === "url_verification" && body.challenge) {
      return new Response(body.challenge);
    }

    if (executionCtx && body.type === "event_callback") {
      executionCtx.waitUntil(processSlackEvent(body, env));
      return new Response("OK");
    }

    await processSlackEvent(body, env);
    return new Response("OK");
  } catch (err) {
    const logRef = createLogRef("slack");
    logEvent(env, "slack_ingest", "handle_event_failed", { error: String(err) }, logRef);
    return new Response("Internal error", { status: 500 });
  }
}

async function processSlackEvent(body: {
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
}, env: Env): Promise<void> {
  logEvent(env, "slack_ingest", "event_received", { type: body.type, eventType: body.event?.type, eventId: body.event_id });

  const eventId = body.event_id || body.event?.ts;
  if (eventId && env.AGENT_DO) {
    if (inFlightEvents.has(eventId)) {
      return;
    }

    inFlightEvents.add(eventId);

    try {
      const key = deriveRoutingKey(body);
      const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName(key));
      const checkRes = await do_.fetch("http://do/events/check", {
        method: "POST",
        body: JSON.stringify({ eventId }),
      });
      const { processed } = await checkRes.json() as { processed: boolean };
      if (processed) {
        return;
      }
    } finally {
      setTimeout(() => inFlightEvents.delete(eventId), 10000);
    }
  }

  if (body.type === "event_callback" && body.event?.type === "message" && body.event.text) {
    const channel = body.event.channel;
    const originalText = body.event.text;

    if (!channel || body.event.bot_id) {
      return;
    }

    if (body.event.thread_ts && body.event.thread_ts === body.event.ts && body.team_id) {
      const threadKey = deriveRoutingKey(body);
      const channelKey = `${body.team_id}:${channel}:channel`;
      const threadDO = env.AGENT_DO.get(env.AGENT_DO.idFromName(threadKey));
      const channelDO = env.AGENT_DO.get(env.AGENT_DO.idFromName(channelKey));
      const channelRes = await channelDO.fetch("http://do/messages?limit=20");
      const { messages } = await channelRes.json() as { messages: Array<{ role: string; content: string; timestamp: number }> };
      await threadDO.fetch("http://do/state/migrate", {
        method: "POST",
        body: JSON.stringify({ channelMessages: messages }),
      });
    }

    const intent = await classifyIntent(originalText, env);

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
      if (result) {
        await postToSlack(channel, `✅ Cron job added: "${intent.schedule}" → "${intent.task}"`, env);
      } else {
        await postToSlack(channel, "❌ Failed to add cron job", env);
      }
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

    const key = deriveRoutingKey(body);
    const conversationDO = env.AGENT_DO ? env.AGENT_DO.get(env.AGENT_DO.idFromName(key)) : null;

    // Fetch conversation history from the Durable Object
    let conversationHistory: Array<{ role: string; content: string }> = [];
    if (conversationDO) {
      try {
        const historyRes = await conversationDO.fetch("http://do/messages?limit=20");
        const { messages } = await historyRes.json() as { messages: Array<{ role: string; content: string; timestamp: number }> };
        conversationHistory = messages.map(({ role, content }) => ({ role, content }));
      } catch {
        // proceed without history if fetch fails
      }
    }

    try {
      if (intent.needsSandbox) {
        const repos = await getRepos(env);
        const repo = repos[0] ?? "default";
        const agent = new PiAgent(env, repo);
        const response = await agent.run(originalText, {
          conversationHistory,
          onProgress: (msg: string) => postToSlack(channel, msg, env),
        });
        // Store the exchange in the DO
        if (conversationDO) {
          await conversationDO.fetch("http://do/messages", { method: "POST", body: JSON.stringify({ role: "user", content: originalText }) });
          await conversationDO.fetch("http://do/messages", { method: "POST", body: JSON.stringify({ role: "assistant", content: response }) });
        }
        await postToSlack(channel, response, env);
      } else {
        const llmMessages: Array<{ role: string; content: string }> = [
          { role: "system", content: "You are a helpful, versatile assistant responding via Slack. Be concise and friendly." },
          ...conversationHistory,
          { role: "user", content: originalText },
        ];
        const response = await callLLM(llmMessages, env);
        // Store the exchange in the DO
        if (conversationDO) {
          await conversationDO.fetch("http://do/messages", { method: "POST", body: JSON.stringify({ role: "user", content: originalText }) });
          await conversationDO.fetch("http://do/messages", { method: "POST", body: JSON.stringify({ role: "assistant", content: response }) });
        }
        await postToSlack(channel, response, env);
      }
    } catch (err) {
      const logRef = createLogRef("slack");
      logEvent(env, "slack_ingest", "process_message_failed", { error: String(err), channel }, logRef);
      await postToSlack(channel, `❌ ${formatSlackError("Unable to process message.", logRef)}`, env);
    }
  }
}

async function postToSlack(channel: string, text: string, env: Env, threadTs?: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;

  let outbound = text;
  if (outbound.startsWith("❌") && !outbound.includes("ref:")) {
    const logRef = createLogRef("slack");
    logEvent(env, "slack_ingest", "error_message_without_ref", { channel, text: outbound }, logRef);
    outbound = `${outbound} (ref: ${logRef})`;
  }

  const plainText = stripFormatting(redactSecrets(outbound, env));

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text: plainText,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
}

function stripFormatting(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""));
}
