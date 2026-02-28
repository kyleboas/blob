import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithModelSelection } from "./llm";
import { getSystemPromptWithCapabilities } from "./capabilities";
import { getCronJobs, addCronJob, deleteCronJob } from "./cron";

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
    const text = body.event.text.toLowerCase();
    const channel = body.event.channel;
    const originalText = body.event.text;

    // Ignore bot messages (including our own)
    if (!channel || body.event.bot_id) return new Response("OK");

    // Handle cron commands
    if (text.includes("show my cron jobs") || text.includes("list my cron jobs")) {
      const jobs = await getCronJobs(env);
      if (jobs.length === 0) {
        await postToSlack(channel, "No cron jobs configured. Add one with: add cron job 'every 5 minutes' to 'run tests'", env);
      } else {
        const list = jobs.map(j => `• ${j.schedule}: ${j.task}`).join("\n");
        await postToSlack(channel, `Your cron jobs:\n${list}`, env);
      }
      return new Response("OK");
    }

    if (text.includes("add cron job") || text.includes("create cron job")) {
      // Parse: add cron job 'every 5 minutes' to 'run tests'
      const match = originalText.match(/(?:add|create)\s+cron\s+job\s+['"](.+?)['"]\s+(?:to\s+)?['"](.+?)['"]/i);
      if (match) {
        const schedule = match[1];
        const task = match[2];
        const result = await addCronJob(env, schedule, task);
        if (result) {
          await postToSlack(channel, `✅ Cron job added: "${schedule}" → "${task}"`, env);
        } else {
          await postToSlack(channel, "❌ Failed to add cron job", env);
        }
      } else {
        await postToSlack(channel, "Format: add cron job 'every 5 minutes' to 'run tests'", env);
      }
      return new Response("OK");
    }

    if (text.includes("delete cron job") || text.includes("remove cron job")) {
      const jobs = await getCronJobs(env);
      if (jobs.length === 0) {
        await postToSlack(channel, "No cron jobs to delete", env);
      } else {
        // For now, delete the most recent one matching the description
        const match = originalText.match(/(?:delete|remove)\s+cron\s+job\s+(.+)/i);
        if (match) {
          const search = match[1].toLowerCase();
          const job = jobs.find(j => j.task.toLowerCase().includes(search));
          if (job) {
            await deleteCronJob(env, job.id);
            await postToSlack(channel, `✅ Deleted cron job: ${job.task}`, env);
          } else {
            await postToSlack(channel, "❌ Cron job not found. Use 'show my cron jobs' to see them.", env);
          }
        }
      }
      return new Response("OK");
    }

    // Get repos for context
    const repos = await getRepos(env);
    const reposContext = repos.join(", ");

    // Build system prompt with capabilities
    const basePrompt = `You are Blob, a helpful AI assistant. You can chat, answer questions, help with coding, and manage repositories: ${reposContext}.`;
    const systemPrompt = getSystemPromptWithCapabilities(basePrompt, env);

    try {
      const result = await callLLMWithModelSelection([
        { role: "system", content: systemPrompt },
        { role: "user", content: originalText }
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