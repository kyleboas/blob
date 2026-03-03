import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMWithModelSelection, callLLM, callLLMStep, getModelSelection, type ToolCall, type ChatMessage } from "./llm";
import { getCronJobs, addCronJob, deleteCronJob } from "./cron";
import { startCodexLogin, saveCodexAuth, runCodex, sandboxStatus, executeInSandbox, readSandboxFile, writeSandboxFile } from "./sandbox";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command in the sandbox. Use for real-time data (date, curl, etc.) or file system operations.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to run" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the contents of a file from the sandbox filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write content to a file in the sandbox filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path to write" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a file by replacing a specific string with new text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path to edit" },
          old: { type: "string", description: "Exact text to find and replace" },
          new: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
];

async function executeTool(toolCall: ToolCall, env: Env): Promise<string> {
  const { name, arguments: argsStr } = toolCall.function;
  let args: Record<string, string>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    return `Error: Could not parse tool arguments: ${argsStr}`;
  }

  try {
    switch (name) {
      case "bash": {
        const result = await executeInSandbox(args.command, env);
        return (result.stdout || result.stderr || "(no output)").slice(0, 4000);
      }
      case "read": {
        const content = await readSandboxFile(args.path, env);
        return content.slice(0, 4000);
      }
      case "write": {
        await writeSandboxFile(args.path, args.content, env);
        return `Written ${args.path}`;
      }
      case "edit": {
        const content = await readSandboxFile(args.path, env);
        if (!content.includes(args.old)) {
          return `Error: Text not found in ${args.path}`;
        }
        await writeSandboxFile(args.path, content.replace(args.old, args.new), env);
        return `Edited ${args.path}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const MAX_TOOL_ITERATIONS = 5;

async function runChatWithTools(
  systemPrompt: string,
  userText: string,
  env: Env,
): Promise<{ content: string; modelUsed: string; modelSwitched: boolean }> {
  const selection = await getModelSelection(userText, env);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const step = await callLLMStep(messages, TOOLS, selection.modelId, selection.maxTokens, env);

    if (!step.tool_calls?.length) {
      return {
        content: step.content ?? "",
        modelUsed: selection.modelName,
        modelSwitched: selection.modelSwitched,
      };
    }

    messages.push({ role: "assistant", content: step.content ?? null, tool_calls: step.tool_calls });
    for (const tc of step.tool_calls) {
      const result = await executeTool(tc, env);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  return {
    content: "I reached the maximum number of tool uses. Please try a more specific request.",
    modelUsed: selection.modelName,
    modelSwitched: selection.modelSwitched,
  };
}

// Track in-flight events to prevent race conditions
const inFlightEvents = new Set<string>();

interface IntentResult {
  intent: "list_cron" | "add_cron" | "delete_cron" | "codex_login" | "codex_run" | "chat";
  schedule?: string;
  task?: string;
  search?: string;
  prompt?: string;
}

const codexLoginRegex = /^(login to codex|login with codex|codex login|codex auth|connect openai)$/i;
const codexRunRegex = /^(run codex|codex run|use codex)[,:]?\s*/i;

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

export async function handleSlackEvent(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Slack URL verification (must respond synchronously)
  if (body.type === "url_verification" && body.challenge) {
    return new Response(body.challenge);
  }

  // Deduplicate using DO with in-flight check (~50ms, kept synchronous)
  const eventId = body.event_id || body.event?.ts;
  if (eventId && env.AGENT_DO) {
    if (inFlightEvents.has(eventId)) return new Response("OK");
    inFlightEvents.add(eventId);
    try {
      const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
      const checkRes = await do_.fetch("http://do/events/check", {
        method: "POST",
        body: JSON.stringify({ eventId }),
      });
      const { processed } = await checkRes.json() as { processed: boolean };
      if (processed) return new Response("OK");
    } finally {
      setTimeout(() => inFlightEvents.delete(eventId), 10000);
    }
  }

  // All slow work runs in the background so we return 200 before Slack's 3s timeout
  if (body.type === "event_callback" && body.event?.type === "message" && body.event.text) {
    const event = body.event;
    if (!event.channel || event.bot_id) return new Response("OK");
    ctx.waitUntil(processMessage(event as Required<typeof event>, env));
  }

  return new Response("OK");
}

async function processMessage(
  event: { type: string; text: string; channel: string; user?: string; bot_id?: string; ts?: string },
  env: Env,
): Promise<void> {
  const channel = event.channel;
  const originalText = event.text;
  const lowerText = originalText.toLowerCase().trim();

  // Fast-path regex detection for common commands (before LLM classification)
  if (codexLoginRegex.test(lowerText)) {
    const status = await sandboxStatus(env);
    if (!status.ready) {
      await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
      return;
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
    return;
  }

  if (codexRunRegex.test(originalText)) {
    const status = await sandboxStatus(env);
    if (!status.ready) {
      await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
      return;
    }
    const prompt = originalText.replace(codexRunRegex, "");
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
        await postToSlack(channel, `❌ Not logged in to Codex.\n\nRun "login to codex" first to authenticate.`, env);
      } else {
        await postToSlack(channel, `❌ Codex error: ${errMsg}`, env);
      }
    }
    return;
  }

  // Check for "done" after login (save auth)
  if (lowerText === "done") {
    try {
      const status = await sandboxStatus(env);
      if (status.ready) {
        const saved = await saveCodexAuth(env);
        if (saved.saved) {
          await postToSlack(channel, `✅ ${saved.message}. You can now run Codex!`, env);
          return;
        }
      }
    } catch {
      // Not a "done" for Codex, continue to chat
    }
  }

  // Classify intent using LLM for other commands
  const intent = await classifyIntent(originalText, env);

  if (intent.intent === "codex_login") {
    const status = await sandboxStatus(env);
    if (!status.ready) {
      await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
      return;
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
    return;
  }

  if (intent.intent === "codex_run") {
    const status = await sandboxStatus(env);
    if (!status.ready) {
      await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
      return;
    }
    const prompt = intent.prompt?.trim() || originalText;
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
        await postToSlack(channel, `❌ Not logged in to Codex.\n\nRun "login to codex" first to authenticate.`, env);
      } else {
        await postToSlack(channel, `❌ Codex error: ${errMsg}`, env);
      }
    }
    return;
  }

  if (intent.intent === "list_cron") {
    const jobs = await getCronJobs(env);
    if (jobs.length === 0) {
      await postToSlack(channel, "No cron jobs configured. Try: 'remind me every 5 minutes to check email'", env);
    } else {
      const list = jobs.map(j => `• ${j.schedule}: ${j.task}`).join("\n");
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
    return;
  }

  // Check for weather queries - handle directly
  const weatherMatch = originalText.match(/weather\s+(?:in\s+)?([a-zA-Z\s]+)/i);
  if (weatherMatch) {
    const location = weatherMatch[1].trim();
    const status = await sandboxStatus(env);
    if (!status.ready) {
      await postToSlack(channel, `❌ Sandbox not available: ${status.message}`, env);
      return;
    }
    await postToSlack(channel, `🌤️ Checking weather in ${location}...`, env);
    try {
      const result = await executeInSandbox(`curl -s "wttr.in/${encodeURIComponent(location)}?format=3"`, env);
      const weather = result.stdout.trim() || result.stderr.trim() || "Could not fetch weather";
      await postToSlack(channel, `Weather in ${location}: ${weather}`, env);
    } catch (err) {
      await postToSlack(channel, `❌ Failed to get weather: ${err}`, env);
    }
    return;
  }

  // General chat with tools
  const repos = await getRepos(env);
  const reposContext = repos.join(", ");
  const systemPrompt = `You are Blob, a helpful AI assistant. You can chat, answer questions, help with coding, and manage repositories: ${reposContext}.

You have tools available: bash (run shell commands), read (read files), write (write files), edit (find-and-replace in files). Use them when needed — for example, run "date" for the current time or "curl" for live data. Be concise and helpful.`;

  try {
    const result = await runChatWithTools(systemPrompt, originalText, env);
    const prefix = result.modelSwitched ? `🤖 (using ${result.modelUsed})\n` : "";
    await postToSlack(channel, prefix + result.content, env);
  } catch {
    await postToSlack(channel, "Sorry, I encountered an error processing your message.", env);
  }
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
