import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithModelSelection } from "./llm";
import { getSystemPromptWithCapabilities } from "./capabilities";

// Track processed event IDs to prevent duplicates
const processedEvents = new Set<string>();
const EVENT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export async function handleSlackEvent(request: Request, env: Env): Promise<Response> {
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

  // Slack URL verification
  if (body.type === "url_verification" && body.challenge) {
    return new Response(body.challenge);
  }

  // Deduplicate by event_id
  const eventId = body.event_id || body.event?.ts;
  if (eventId) {
    if (processedEvents.has(eventId)) {
      return new Response("OK"); // Already processed
    }
    processedEvents.add(eventId);

    // Clean up old events after timeout
    setTimeout(() => processedEvents.delete(eventId), EVENT_TIMEOUT);
  }

  // Handle message events
  if (body.type === "event_callback" && body.event?.type === "message" && body.event.text) {
    const text = body.event.text;
    const channel = body.event.channel;

    // Ignore bot messages (including our own)
    if (!channel || body.event.bot_id) return new Response("OK");

    // Get repos for context
    const repos = await getRepos(env);
    const reposContext = repos.join(", ");

    // Build system prompt with capabilities
    const basePrompt = `You are Blob, a helpful AI assistant. You can chat, answer questions, help with coding, and manage repositories: ${reposContext}.

IMPORTANT: Always respond in plain text only. Do not use markdown, code blocks, bold, italics, or any formatting. Just plain text.`;
    const systemPrompt = getSystemPromptWithCapabilities(basePrompt, env);

    try {
      const result = await callLLMWithModelSelection([
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ], env, { maxTokens: 2000 });

      const prefix = result.modelSwitched ? `🤖 (using ${result.modelUsed})\n` : "";
      await postToSlack(channel, prefix + result.content, env);
    } catch {
      await postToSlack(channel, "Sorry, I encountered an error processing your message.", env);
    }
  }

  return new Response("OK");
}

async function postToSlack(channel: string, text: string, env: Env): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
    }),
  });
}
