import type { Env } from "../core/types";
import { deriveRoutingKey, verifySlackSignature } from "./slack-routing";
import { createLogRef, logEvent } from "../core/observability";
import { redactSecrets } from "../core/safety";
import { classifyIntent, handleCommand } from "./slack-commands";
import { processIntentOrChat, type SlackEventPayload } from "./slack-message-processing";

const inFlightEvents = new Set<string>();

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

    const body = await request.json() as SlackEventPayload;
    if (body.type === "url_verification" && body.challenge) {
      return new Response(body.challenge);
    }

    if (executionCtx && body.type === "event_callback") {
      executionCtx.waitUntil(processSlackMessage(body, env));
      return new Response("OK");
    }

    await processSlackMessage(body, env);
    return new Response("OK");
  } catch (err) {
    const logRef = createLogRef("slack");
    logEvent(env, "slack_ingest", "handle_event_failed", { error: String(err) }, logRef);
    return new Response("Internal error", { status: 500 });
  }
}

async function processSlackMessage(body: SlackEventPayload, env: Env): Promise<void> {
  logEvent(env, "slack_ingest", "event_received", { type: body.type, eventType: body.event?.type, eventId: body.event_id });

  if (!(body.type === "event_callback" && body.event?.type === "message" && body.event.text)) return;
  if (!body.event.channel || body.event.bot_id) return;

  const eventId = body.event_id || body.event.ts;
  if (eventId && env.AGENT_DO) {
    if (inFlightEvents.has(eventId)) return;
    inFlightEvents.add(eventId);
    try {
      const key = deriveRoutingKey(body);
      const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName(key));
      const checkRes = await do_.fetch("http://do/events/check", {
        method: "POST",
        body: JSON.stringify({ eventId }),
      });
      const { processed } = await checkRes.json() as { processed: boolean };
      if (processed) return;
    } finally {
      setTimeout(() => inFlightEvents.delete(eventId), 10000);
    }
  }

  const key = deriveRoutingKey(body);
  const conversationDO = env.AGENT_DO ? env.AGENT_DO.get(env.AGENT_DO.idFromName(key)) : null;
  const commandResult = await handleCommand(body.event.text, body.event.channel, env, conversationDO);
  if (commandResult.handled) {
    if (commandResult.response) {
      const isSelftest = body.event.text.trim().toLowerCase() === "selftest";
      if (isSelftest && commandResult.response.includes("\n")) {
        const [lead, ...rest] = commandResult.response.split("\n");
        if (lead) await postToSlack(body.event.channel, lead, env);
        const remainder = rest.join("\n").trim();
        if (remainder) await postToSlack(body.event.channel, remainder, env);
      } else {
        await postToSlack(body.event.channel, commandResult.response, env);
      }
    }
    return;
  }

  const intent = await classifyIntent(body.event.text, env);
  await processIntentOrChat({
    body,
    intent,
    env,
    conversationDO,
    conversationKey: key,
    postToSlack,
    formatSlackError,
  });
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
