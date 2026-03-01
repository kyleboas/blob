import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithModelSelection, callLLM } from "./llm";
import { getSystemPromptWithCapabilities } from "./capabilities";
import { getCronJobs, addCronJob, deleteCronJob } from "./cron";
import { startCodexLogin, saveCodexAuth, runCodex, sandboxStatus } from "./sandbox";

// Track in-flight events to prevent race conditions
const inFlightEvents = new Set<string>();

interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "codex_login" | "codex_run" | "chat";
  schedule?: string;
  task?: string;
  search?: string;
  prompt?: string;
}

async function classifyIntent(text: string, env: Env): Promise<IntentResult> {
  const prompt = `You are an intent classifier for a Slack bot. Analyze the message and extract the user's intent.

Possible intents:
- "list_cron": User wants to see their scheduled cron jobs (e.g., "show my jobs", "what tasks do I have", "list my cron jobs")
- "add_cron": User wants to create a new scheduled task (e.g., "remind me every 5 minutes to check email", "add a job to run tests daily")
- "delete_cron": User wants to remove a scheduled task (e.g., "delete the email reminder", "remove my test job")
- "codex_login": User wants to login to Codex/OpenAI (e.g., "login to codex", "codex auth", "connect openai")
- "codex_run": User wants to run Codex (e.g., "run codex", "use codex to fix this", "codex: refactor this code")
- "chat": General conversation, not a specific command

For "add_cron", extract:
- schedule: The time pattern (e.g., "every 5 minutes", "daily at 9am", "hourly")
- task: What to do (e.g., "check email", "run tests", "backup database")

For "delete_cron", extract:
- search: Keywords to find the job to delete (e.g., "email", "test", "backup")

For "codex_run", extract:
- prompt: The task for Codex (e.g., "fix this bug", "refactor the auth module")

Respond with ONLY a JSON object in this format:
{"intent": "list_cron|add_cron|delete_cron|codex_login|codex_run|chat", "schedule": "...", "task": "...", "search": "...", "prompt": "..."}

Message: "${text}"`;

  try {
    const response = await callLLM([{ role: "user", content: prompt }], env, { maxTokens: 200 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as IntentResult;
    }
  } catch {
    // Fallback to chat if parsing fails
  }
  return { intent: "chat" };
}

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
  if (eventId && env.AGENT_DO) {
    // Check if already processing
    if (inFlightEvents.has(eventId)) {
      return new Response("OK");
    }
    
    // Mark as in-flight immediately
    inFlightEvents.add(eventId);
    
    try {
      const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
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
    const channel = body.event.channel;
    const originalText = body.event.text;

    // Ignore bot messages (including our own)
    if (!channel || body.event.bot_id) return new Response("OK");

    // Fast-path regex detection for common commands (before LLM classification)
    const lowerText = originalText.toLowerCase().trim();
    
    // Codex commands
    if (/^(login to codex|codex login|codex auth|connect openai)$/.test(lowerText)) {
      const status = await sandboxStatus(env);
      if (!status.ready) {
        await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
        return new Response("OK");
      }

      try {
        const login = await startCodexLogin(env);
        await postToSlack(channel, 
          `🔐 **Codex Login Required**\n\n` +
          `1. Open: ${login.url}\n` +
          `2. Enter code: \`${login.code || "see instructions"}\`\n` +
          `3. Complete login on your device\n` +
          `4. Reply here with "done" to save credentials`,
          env
        );
      } catch (err) {
        await postToSlack(channel, `❌ Codex login failed: ${err}`, env);
      }
      return new Response("OK");
    }

    if (/^(run codex|codex run|use codex)/.test(lowerText)) {
      const status = await sandboxStatus(env);
      if (!status.ready) {
        await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
        return new Response("OK");
      }

      const prompt = originalText.replace(/^(run codex|codex run|use codex)[,:]?\s*/i, "");
      
      await postToSlack(channel, `🤖 Running Codex: "${prompt}"...`, env);
      
      try {
        const result = await runCodex(prompt, env);
        const output = result.stdout || result.stderr || "No output";
        await postToSlack(channel, 
          `✅ Codex completed (exit: ${result.exitCode})\n\n` +
          "```\n" + output.slice(0, 3000) + "\n```",
          env
        );
      } catch (err) {
        const errMsg = String(err);
        if (errMsg.includes("Not authenticated")) {
          await postToSlack(channel, 
            `❌ Not logged in to Codex.\n\n` +
            `Run "login to codex" first to authenticate.`,
            env
          );
        } else {
          await postToSlack(channel, `❌ Codex error: ${errMsg}`, env);
        }
      }
      return new Response("OK");
    }

    // Check for "done" after login (save auth)
    if (lowerText === "done") {
      try {
        const status = await sandboxStatus(env);
        if (status.ready) {
          const saved = await saveCodexAuth(env);
          if (saved.saved) {
            await postToSlack(channel, `✅ ${saved.message}. You can now run Codex!`, env);
            return new Response("OK");
          }
        }
      } catch {
        // Not a "done" for Codex, continue to chat
      }
    }

    // Classify intent using LLM for other commands
    const intent = await classifyIntent(originalText, env);

    // Handle cron commands based on LLM intent
    if (intent.intent === "list_cron") {
      const jobs = await getCronJobs(env);
      if (jobs.length === 0) {
        await postToSlack(channel, "No cron jobs configured. Try: 'remind me every 5 minutes to check email'", env);
      } else {
        const list = jobs.map(j => `• ${j.schedule}: ${j.task}`).join("\n");
        await postToSlack(channel, `Your cron jobs:\n${list}`, env);
      }
      return new Response("OK");
    }

    if (intent.intent === "add_cron" && intent.schedule && intent.task) {
      const result = await addCronJob(env, intent.schedule, intent.task);
      if (result) {
        await postToSlack(channel, `✅ Cron job added: "${intent.schedule}" → "${intent.task}"`, env);
      } else {
        await postToSlack(channel, "❌ Failed to add cron job", env);
      }
      return new Response("OK");
    }

    if (intent.intent === "delete_cron") {
      const jobs = await getCronJobs(env);
      if (jobs.length === 0) {
        await postToSlack(channel, "No cron jobs to delete", env);
      } else if (intent.search) {
        const job = jobs.find(j => j.task.toLowerCase().includes(intent.search!.toLowerCase()));
        if (job) {
          await deleteCronJob(env, job.id);
          await postToSlack(channel, `✅ Deleted cron job: ${job.task}`, env);
        } else {
          await postToSlack(channel, `❌ No job matching "${intent.search}" found.`, env);
        }
      } else {
        await postToSlack(channel, "Which job would you like to delete? Try: 'delete my email reminder job'", env);
      }
      return new Response("OK");
    }

    // Get repos for context
    const repos = await getRepos(env);
    const reposContext = repos.join(", ");

    // Build system prompt - simpler, no capabilities wall
    const systemPrompt = `You are Blob, a helpful AI assistant. You can chat, answer questions, help with coding, and manage repositories: ${reposContext}. Be concise and helpful.`;

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