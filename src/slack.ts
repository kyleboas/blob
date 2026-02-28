import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithModelSelection } from "./llm";
import { getSystemPromptWithCapabilities } from "./capabilities";

// Track in-flight events to prevent race conditions
const inFlightEvents = new Set<string>();

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

  // Deduplicate using DO with in-flight check
  const eventId = body.event_id || body.event?.ts;
  if (eventId && env.BLOB) {
    // Check if already processing
    if (inFlightEvents.has(eventId)) {
      return new Response("OK");
    }
    
    // Mark as in-flight immediately
    inFlightEvents.add(eventId);
    
    try {
      const do_ = env.BLOB.get(env.BLOB.idFromName("blob"));
      const checkRes = await do_.fetch("http://do/events/check", {
        method: "POST",
        body: JSON.stringify({ eventId }),
      });
      const { processed } = await checkRes.json() as { processed: boolean };
      if (processed) {
        return new Response("OK");
      }
    } finally {
      // Remove from in-flight after 10s
      setTimeout(() => inFlightEvents.delete(eventId), 10000);
    }
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
    const basePrompt = `You are Blob, a helpful AI assistant. You can chat, answer questions, help with coding, and manage repositories: ${reposContext}.`;
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

  // Strip markdown formatting
  const plainText = stripFormatting(text);

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text: plainText,
    }),
  });
}

function stripFormatting(text: string): string {
  return text
    // Convert **bold** to *bold* (Slack format)
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    // Remove # headers (just remove the #)
    .replace(/^#{1,6}\s+/gm, '')
    // Keep: `code`, ```code blocks```, [links](url), > quotes, --- rules
    .trim();
}