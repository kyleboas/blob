import type { RouterCtx } from "../do-router";
import { deriveRoutingKey } from "../../integrations/slack-routing";
import { createLogRef, logEvent } from "../../core/observability";
import { redactSecrets } from "../../core/safety";
import { classifyIntent, getExactKeywordCommand, handleCommand } from "../../integrations/slack-commands";
import {
  answerRepoConnectivityQuestion,
  isRepoConnectivityQuestion,
  processIntentOrChat,
  type SlackEventPayload,
} from "../../integrations/slack-message-processing";
import { checkRateLimit, configureRateLimit } from "../../integrations/slack-rate-limit";
import { parseDirectSandboxTask } from "../../integrations/slack-simple-sandbox";
import type { Env } from "../../core/types";

type BackgroundCommand = "selftest" | "self-improve";
type SlackIntent = Awaited<ReturnType<typeof classifyIntent>>;

type MessageRoute =
  | { kind: "background-command"; command: BackgroundCommand }
  | { kind: "direct-command" }
  | { kind: "repo-question" }
  | { kind: "chat"; intentHint?: SlackIntent };

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

async function postHandledCommandResponse(
  body: SlackEventPayload,
  commandResponse: string | undefined,
  env: Env,
  options?: { selftestLeadAlreadyPosted?: boolean },
): Promise<void> {
  const channel = body.event?.channel;
  if (!channel || !commandResponse) return;

  const isSelftest = getExactKeywordCommand(body.event?.text ?? "") === "selftest";
  if (isSelftest) {
    const lines = commandResponse.split("\n");
    const shouldDropLead = options?.selftestLeadAlreadyPosted && lines[0]?.trim().toLowerCase() === "running self-test…";
    const payloadLines = shouldDropLead ? lines.slice(1) : lines;
    const payload = payloadLines.join("\n").trim();
    if (payload) await postToSlack(channel, payload, env);
    return;
  }

  await postToSlack(channel, commandResponse, env);
}

function classifyMessageRoute(text: string): MessageRoute {
  const keywordCommand = getExactKeywordCommand(text);
  if (keywordCommand === "selftest" || keywordCommand === "self-improve") {
    return { kind: "background-command", command: keywordCommand };
  }
  if (keywordCommand) {
    return { kind: "direct-command" };
  }
  if (isRepoConnectivityQuestion(text)) {
    return { kind: "repo-question" };
  }
  if (parseDirectSandboxTask(text)) {
    return { kind: "chat", intentHint: { intent: "chat", needsSandbox: true, externalDataOnly: false } };
  }

  if (looksLikeCronRequest(text)) {
    return { kind: "chat" };
  }

  if (looksLikeRepoTask(text)) {
    return { kind: "chat", intentHint: { intent: "chat", needsSandbox: true, externalDataOnly: false } };
  }

  if (looksLikeExternalDataTask(text)) {
    return { kind: "chat", intentHint: { intent: "chat", needsSandbox: true, externalDataOnly: true } };
  }

  return { kind: "chat", intentHint: { intent: "chat", needsSandbox: false, externalDataOnly: false } };
}

function looksLikeCronRequest(text: string): boolean {
  return /\b(remind me|cron|schedule|every \d+|hourly|daily|weekly|monthly|delete .*job|list .*job)\b/i.test(text);
}

function looksLikeRepoTask(text: string): boolean {
  return /\b(read|open|show|inspect|summarize|explain|edit|write|create|update|delete|run|test|fix|debug|grep|search)\b/i.test(text)
    && /(^|\s)(src\/|docs\/|package\.json|README\.md|wrangler\.|\.ts\b|\.tsx\b|\.js\b|\.md\b|file\b|repo\b|repository\b|health\b|selftest\b)/i.test(text);
}

function looksLikeExternalDataTask(text: string): boolean {
  return /\b(weather|forecast|temperature|stock|price|score|news|latest|current|today|now|website|status of|who is|search the web|look up|browse)\b/i.test(text);
}

async function runDeferredMessageProcessing(
  body: SlackEventPayload,
  ctx: RouterCtx,
  conversationDO: DurableObjectStub | null,
  conversationKey: string,
  route: Extract<MessageRoute, { kind: "background-command" | "chat" }>,
): Promise<void> {
  const env = ctx.env;
  const channel = body.event?.channel;
  if (!body.event?.text || !channel) return;

  const text = body.event.text;

  if (route.kind === "background-command") {
    const commandResult = await handleCommand(text, channel, env, conversationDO);
    if (commandResult.handled) {
      await postHandledCommandResponse(body, commandResult.response, env, { selftestLeadAlreadyPosted: route.command === "selftest" });
    }
    return;
  }

  const intent = route.intentHint ?? await classifyIntent(text, env);

  // Wrap processIntentOrChat in a timeout so the DO posts a fallback before being killed.
  // Cloudflare DOs have a wall-clock limit; if we exceed it silently the user gets no response.
  // Default: 85s (safely under the ~100s observed limit, with headroom for the Slack post itself).
  const timeoutMs = Number.parseInt(env.MESSAGE_TIMEOUT_MS ?? "85000", 10);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`message_timeout_${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([
      processIntentOrChat({
        body,
        intent,
        env,
        conversationDO,
        conversationKey,
        postToSlack,
        formatSlackError,
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("message_timeout_")) {
      const logRef = createLogRef("slack");
      logEvent(env, "slack_ingest", "message_timeout", { channel, timeoutMs }, logRef);
      await postToSlack(
        channel,
        `⏱️ This request is taking longer than expected. I'm still working on it — please try again in a moment if you don't hear back. (ref: ${logRef})`,
        env,
      ).catch(() => {});
    } else {
      const logRef = createLogRef("slack");
      logEvent(env, "slack_ingest", "process_message_failed", { error: msg, channel }, logRef);
      await postToSlack(channel, `❌ ${formatSlackError("Unable to process message.", logRef)}`, env).catch(() => {});
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const text = body.event.text;
  const route = classifyMessageRoute(text);

  if (route.kind === "background-command") {
    if (route.command === "selftest") {
      await postToSlack(body.event.channel, "Running self-test…", env);
    }
    ctx.state.waitUntil(runDeferredMessageProcessing(body, ctx, conversationDO, key, route));
    return new Response("OK");
  }

  if (route.kind === "direct-command") {
    const commandResult = await handleCommand(text, body.event.channel, env, conversationDO);
    if (commandResult.handled) {
      await postHandledCommandResponse(body, commandResult.response, env);
      return new Response("OK");
    }
    logEvent(env, "slack_ingest", "direct_command_unhandled", { text, channel: body.event.channel });
    ctx.state.waitUntil(runDeferredMessageProcessing(body, ctx, conversationDO, key, { kind: "chat" }));
    return new Response("OK");
  }

  if (route.kind === "repo-question") {
    await postToSlack(body.event.channel, await answerRepoConnectivityQuestion(env), env);
    return new Response("OK");
  }

  ctx.state.waitUntil(runDeferredMessageProcessing(body, ctx, conversationDO, key, route));
  return new Response("OK");
}
