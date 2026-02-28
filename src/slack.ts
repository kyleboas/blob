import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithModelSelection } from "./llm";
import { SessionManager } from "./session";

// In-memory session managers per channel
const sessionManagers = new Map<string, SessionManager>();

export async function handleSlackEvent(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    type?: string;
    challenge?: string;
    event?: {
      type: string;
      text?: string;
      channel?: string;
      user?: string;
      bot_id?: string;
    };
  };

  // Slack URL verification
  if (body.type === "url_verification" && body.challenge) {
    return new Response(body.challenge);
  }

  // Handle message events
  if (body.type === "event_callback" && body.event?.type === "message" && body.event.text) {
    const text = body.event.text;
    const channel = body.event.channel;

    // Ignore bot messages (including our own)
    if (!channel || body.event.bot_id) return new Response("OK");

    // Get or create session manager for this channel
    let session = sessionManagers.get(channel);
    if (!session) {
      session = new SessionManager();
      sessionManagers.set(channel, session);
    }

    // Parse message type
    const isSteering = text.startsWith("!"); // ! for immediate/steering
    const isFollowUp = text.startsWith("?"); // ? for follow-up
    const cleanText = text.replace(/^[!?]\s*/, "");

    if (isSteering) {
      // Steering message - queue and potentially interrupt
      session.queueSteeringMessage(cleanText);
      await postToSlack(channel, "🎯 Steering message queued (will interrupt current work)", env);
      
      // Process immediately if not already processing
      processMessageQueue(channel, session, env);
    } else if (isFollowUp) {
      // Follow-up message - queue for after current work
      session.queueFollowUpMessage(cleanText);
      await postToSlack(channel, "💬 Follow-up queued (will process after current work)", env);
    } else {
      // Regular message - treat as steering by default
      session.queueSteeringMessage(cleanText);
      processMessageQueue(channel, session, env);
    }
  }

  return new Response("OK");
}

async function processMessageQueue(channel: string, session: SessionManager, env: Env): Promise<void> {
  // Check if already processing (simple lock)
  if ((session as any)._processing) return;
  (session as any)._processing = true;

  try {
    while (true) {
      const message = session.dequeueMessage();
      if (!message) break;

      // Check for interruption (steering message arrived mid-processing)
      if (message.type === "follow-up" && session.hasSteeringMessages()) {
        // Skip follow-up, steering takes priority
        session.queueFollowUpMessage(message.content); // Re-queue
        continue;
      }

      // Process the message
      await processMessage(channel, session, message.content, env);

      // Check if steering arrived during processing (for tool skip)
      if (session.hasSteeringMessages()) {
        await postToSlack(channel, "⚠️ Interrupted by steering message", env);
        // Continue loop to process steering
      }
    }
  } finally {
    (session as any)._processing = false;
  }
}

async function processMessage(
  channel: string, 
  session: SessionManager, 
  text: string, 
  env: Env
): Promise<void> {
  const repos = await getRepos(env);
  const reposContext = repos.join(", ");

  const systemPrompt = `You are Blob, an autonomous coding agent. You manage repositories: ${reposContext}. You can add repos, set goals, and run tasks. Be helpful and concise.`;

  // Add to session history
  session.addMessage("user", text);

  try {
    const result = await callLLMWithModelSelection([
      { role: "system", content: systemPrompt },
      ...session.getCurrentMessages().slice(-10), // Include recent context
      { role: "user", content: text }
    ], env, { maxTokens: 2000 });

    // Add assistant response to history
    session.addMessage("assistant", result.content);

    const prefix = result.modelSwitched ? `🤖 (using ${result.modelUsed})\n` : "";
    await postToSlack(channel, prefix + result.content, env);
  } catch (err) {
    await postToSlack(channel, "Sorry, I encountered an error processing your message.", env);
  }
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
