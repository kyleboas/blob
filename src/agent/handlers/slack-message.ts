import type { RouterCtx } from "../do-router";
import { deriveRoutingKey } from "../../integrations/slack-routing";
import { createLogRef, logEvent } from "../../core/observability";
import { redactSecrets } from "../../core/safety";
import { classifyIntent, handleCommand } from "../../integrations/slack-commands";
import { processIntentOrChat, type SlackEventPayload } from "../../integrations/slack-message-processing";
import { checkRateLimit, configureRateLimit } from "../../integrations/slack-rate-limit";
import type { Env } from "../../core/types";

function formatSlackError(message: string, logRef: string): string {
  return `A system error occurred. Please retry. (ref: ${logRef})\n${message}`;
}

async function postToSlack(channel: string, text: string, env: Env, threadTs?: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;

  let outbound = text;
  if (outbound.startsWith("❌") && !outbound.includes("ref:")) {
    const logRef = createLogRef("slack");
    logEvent(env, "slack_ingest", "error_message_without_ref", { channel, text: outbound }, logRef);
    outbound = `${outbound} (ref: ${logRef})`;
  }

  let plainText = stripFormatting(redactSecrets(outbound, env)).trim();
  if (!plainText) {
    plainText = "(No textual response generated. Please check logs/tool output.)";
  }
  const slackMaxText = 39000;
  if (plainText.length > slackMaxText) {
    plainText = `${plainText.slice(0, slackMaxText)}\n\n…(truncated)`;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
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

  const result = await response.json().catch(() => ({ ok: response.ok })) as { ok?: boolean };
  if (!response.ok || !result.ok) {
    throw new Error(`Slack post failed (${response.status}): ${JSON.stringify(result)}`);
  }
}

function stripFormatting(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""));
}

export async function handleProcessMessage(request: Request, ctx: RouterCtx): Promise<Response> {
  const body = await request.json() as SlackEventPayload;
  const env = ctx.env;

  logEvent(env, "slack_ingest", "event_received", { type: body.type, eventType: body.event?.type, eventId: body.event_id });

  if (!(body.type === "event_callback" && body.event?.type === "message" && body.event.text)) return new Response("OK");
  if (!body.event.channel || body.event.bot_id) return new Response("OK");

  configureRateLimit({
    windowMs: Number.parseInt(env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
    maxMessages: Number.parseInt(env.RATE_LIMIT_MAX_MESSAGES ?? "20", 10),
  });
  const limit = checkRateLimit(body.event.channel, Date.now());
  if (!limit.allowed) {
    const waitSeconds = Math.ceil((limit.retryAfterMs ?? 0) / 1000);
    await postToSlack(body.event.channel, `⏳ Rate limit reached for this channel. Please retry in ~${waitSeconds}s.`, env);
    logEvent(env, "slack_ingest", "rate_limited", {
      channel: body.event.channel,
      retryAfterMs: limit.retryAfterMs ?? 0,
    });
    return new Response("OK");
  }

  const eventId = body.event_id || body.event.ts;
  if (eventId) {
    const events = ctx.data.processedEvents || [];
    const now = Date.now();
    const validEvents = events.filter((e) => now - e.timestamp < 5 * 60 * 1000);
    if (validEvents.some((e) => e.id === eventId)) {
      return new Response("OK");
    }
    validEvents.push({ id: eventId, timestamp: now });
    ctx.data.processedEvents = validEvents;
    await ctx.save();
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
    return new Response("OK");
  }

  const intent = await classifyIntent(body.event.text, env);

  // Wrap processIntentOrChat in a timeout so the DO posts a fallback before being killed.
  // Cloudflare DOs have a wall-clock limit; if we exceed it silently the user gets no response.
  // Default: 85s (safely under the ~100s observed limit, with headroom for the Slack post itself).
  const timeoutMs = Number.parseInt(env.MESSAGE_TIMEOUT_MS ?? "85000", 10);
  const channel = body.event?.channel;

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`message_timeout_${timeoutMs}ms`)), timeoutMs),
  );

  try {
    await Promise.race([
      processIntentOrChat({
        body,
        intent,
        env,
        conversationDO,
        conversationKey: key,
        postToSlack,
        formatSlackError,
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("message_timeout_") && channel) {
      const logRef = createLogRef("slack");
      logEvent(env, "slack_ingest", "message_timeout", { channel, timeoutMs }, logRef);
      await postToSlack(
        channel,
        `⏱️ This request is taking longer than expected. I'm still working on it — please try again in a moment if you don't hear back. (ref: ${logRef})`,
        env,
      ).catch(() => {});
    } else if (channel) {
      const logRef = createLogRef("slack");
      logEvent(env, "slack_ingest", "process_message_failed", { error: msg, channel }, logRef);
      await postToSlack(channel, `❌ ${formatSlackError("Unable to process message.", logRef)}`, env).catch(() => {});
    }
  }

  return new Response("OK");
}
