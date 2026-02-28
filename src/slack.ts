import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithRouting } from "./llm";

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

    // Get repos for context
    const repos = await getRepos(env);
    const reposContext = repos.join(", ");

    // Send to LLM with model routing
    const systemPrompt = `You are Blob, an autonomous coding agent. You manage repositories: ${reposContext}. You can add repos, set goals, and run tasks. Be helpful and concise.`;
    
    try {
      const response = await callLLMWithRouting([
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ], env, text);

      await postToSlack(channel, response, env);
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
