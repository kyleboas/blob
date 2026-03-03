import type { Env } from "./types";
import { getRepos } from "./storage";
import { callLLMStep, getModelSelection, type ToolCall, type ChatMessage } from "./llm";
import { getCronJobs, addCronJob, deleteCronJob } from "./cron";
import { executeInSandbox, readSandboxFile, writeSandboxFile } from "./sandbox";

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
  {
    type: "function",
    function: {
      name: "list_cron",
      description: "List all scheduled cron jobs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "add_cron",
      description: "Create a new scheduled cron job.",
      parameters: {
        type: "object",
        properties: {
          schedule: { type: "string", description: "Human schedule like 'every 5 minutes' or a cron expression" },
          task: { type: "string", description: "Description of what to do" },
        },
        required: ["schedule", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_cron",
      description: "Delete a scheduled cron job by keyword match.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Keyword that appears in the job description" },
        },
        required: ["search"],
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
      case "list_cron": {
        const jobs = await getCronJobs(env);
        if (!jobs.length) return "No cron jobs configured.";
        return jobs.map(j => `• ${j.id}: ${j.schedule} → ${j.task}`).join("\n");
      }
      case "add_cron": {
        const ok = await addCronJob(env, args.schedule, args.task);
        return ok ? `Cron job added: "${args.schedule}" → "${args.task}"` : "Failed to add cron job";
      }
      case "delete_cron": {
        const jobs = await getCronJobs(env);
        const job = jobs.find(j => j.task.toLowerCase().includes(args.search.toLowerCase()));
        if (!job) return `No job matching "${args.search}" found`;
        await deleteCronJob(env, job.id);
        return `Deleted: ${job.task}`;
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
  const repos = await getRepos(env);
  const systemPrompt = `You are Blob, a helpful AI assistant. Repos: ${repos.join(", ")}.

Tools: bash, read, write, edit, list_cron, add_cron, delete_cron.
For any coding task (writing, fixing, or refactoring code), use bash to run: codex "<task>"
Use tools whenever you need real data or to take action. Be concise.`;

  try {
    const result = await runChatWithTools(systemPrompt, event.text, env);
    const prefix = result.modelSwitched ? `[${result.modelUsed}] ` : "";
    await postToSlack(event.channel, prefix + result.content, env);
  } catch {
    await postToSlack(event.channel, "Sorry, I encountered an error processing your message.", env);
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
