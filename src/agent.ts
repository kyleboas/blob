import { Agent } from "@cloudflare/agents";
import { MAX_STEPS, TOOL_RETRY_MAX, TOOL_RETRY_BACKOFF_BASE_MS } from "./config";
import { callLLM, type LLMResponse } from "./llm";
import { enforceSafety } from "./safety";
import { SandboxClient, type SandboxBinding } from "./sandbox-client";
import {
  getHistory,
  incrementRateLimit,
  initSchema,
  restoreRepoSnapshot,
  saveMessage,
  saveRepoSnapshot,
  syncKnowledgeFromSandbox,
  syncKnowledgeToSandbox,
  type SqlStorage
} from "./storage";
import { BASH_TOOL, formatToolResult } from "./tools";
import { postApprovalRequest, postMessage } from "./slack";
import { createApprovalRequest, expireTimedOutApprovals, resolveApprovalReaction, type PendingApproval } from "./approval";
import type { Env, SlackEvent } from "./types";

interface DurableObjectStateLike {
  storage: {
    sql: SqlStorage;
    setAlarm?: (scheduledTime: number | Date) => Promise<void> | void;
  };
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: { command?: string };
}

interface TextBlock {
  type: "text";
  text: string;
}

interface AgentDeps {
  llmCall: typeof callLLM;
  postSlackMessage: typeof postMessage;
  postSlackApproval: typeof postApprovalRequest;
  now: () => number;
}

const DEFAULT_DEPS: AgentDeps = {
  llmCall: callLLM,
  postSlackMessage: postMessage,
  postSlackApproval: postApprovalRequest,
  now: () => Date.now()
};

const SYSTEM_PROMPT = [
  "You are Blob, a careful coding agent.",
  "Use tools when needed.",
  "When a user asks about content from a URL, use the bash tool to fetch the page first (for example with curl) before answering.",
  "Do not claim a URL is inaccessible unless you have attempted a fetch command and observed an error."
].join(" ");

const UNCONFIGURED_SANDBOX: SandboxBinding = {
  async exec() {
    throw new Error("Sandbox binding is not configured. Set env.SANDBOX via a service binding before running commands.");
  },
  async writeFile() {
    throw new Error("Sandbox binding is not configured. Set env.SANDBOX via a service binding before syncing files.");
  },
  async readFile() {
    throw new Error("Sandbox binding is not configured. Set env.SANDBOX via a service binding before reading files.");
  }
};

function isCloudflareApplyCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /\bwrangler\s+(deploy|publish)\b/.test(normalized)
    || normalized.includes("api.cloudflare.com")
    || /workers\/scripts/.test(normalized);
}

export class AgentDO extends Agent {
  private readonly db: SqlStorage;
  private readonly sandbox: SandboxClient;
  private readonly deps: AgentDeps;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly ctx: DurableObjectStateLike, private readonly env: Env, deps: Partial<AgentDeps> = {}) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.sandbox = new SandboxClient((env.SANDBOX as unknown as SandboxBinding | undefined) ?? UNCONFIGURED_SANDBOX);
    this.deps = { ...DEFAULT_DEPS, ...deps };
    initSchema(this.db);
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as { action?: string; event?: SlackEvent; task?: string };

    if (body.action === "reaction" && body.event) {
      await this.handleApprovalReaction(body.event);
      return new Response("ok");
    }

    if (body.action === "message" && body.event) {
      const event = body.event;
      try {
        await this.handleTaskEvent(event);
      } catch (error) {
        const threadTs = event.thread_ts ?? event.ts;
        const channel = event.channel;
        if (channel && threadTs) {
          const message = error instanceof Error ? error.message : "An unexpected error occurred.";
          await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, `Error: ${message}`, threadTs);
        }
      }
      return new Response("accepted", { status: 202 });
    }

    if (body.task && body.event?.thread_ts && body.event.channel) {
      await this.runAgentLoop(body.task, body.event.channel, body.event.thread_ts);
      return new Response("accepted", { status: 202 });
    }

    return new Response("bad request", { status: 400 });
  }

  async runAgentLoop(task: string, channel: string, threadTs: string): Promise<{ finalText: string; steps: number }> {
    const conversation = getHistory(this.db, threadTs);
    if (conversation.length === 0) {
      saveMessage(this.db, threadTs, { role: "user", content: task });
      conversation.push({ role: "user", content: task });
    }

    // Fire "Thinking..." and the first LLM call concurrently
    const [firstResponse] = await Promise.all([
      this.deps.llmCall({
        apiKey: this.env.ANTHROPIC_API_KEY,
        systemPrompt: SYSTEM_PROMPT,
        messages: conversation,
        tools: [BASH_TOOL]
      }),
      this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, "Thinking...", threadTs)
    ]);

    let finalText = "";
    let steps = 0;
    let sessionStarted = false;
    let llmResponse = firstResponse;

    try {
      while (steps < MAX_STEPS) {
        steps += 1;

        const blocks = llmResponse.content as Array<ToolUseBlock | TextBlock>;
        const hasToolUse = blocks.some((b) => b.type === "tool_use");

        if (!hasToolUse) {
          finalText = blocks
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim() || "Done.";
          break;
        }

        if (!sessionStarted) {
          await this.startSession(threadTs);
          sessionStarted = true;
        }

        const decision = await this.processLlmResponse(llmResponse, channel, threadTs, task);
        if (decision.done) {
          finalText = decision.text;
          break;
        }

        conversation.push({ role: "assistant", content: decision.observation });
        saveMessage(this.db, threadTs, { role: "assistant", content: decision.observation });

        llmResponse = await this.deps.llmCall({
          apiKey: this.env.ANTHROPIC_API_KEY,
          systemPrompt: SYSTEM_PROMPT,
          messages: conversation,
          tools: [BASH_TOOL]
        });
      }
    } finally {
      if (sessionStarted) {
        await this.endSession(threadTs);
      }
    }

    if (!finalText) {
      finalText = `Stopped after reaching max steps (${MAX_STEPS}).`;
    }

    await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, finalText, threadTs);

    return { finalText, steps };
  }

  private async processLlmResponse(
    llmResponse: LLMResponse,
    channel: string,
    threadTs: string,
    sessionId: string
  ): Promise<{ done: boolean; text: string; observation: string }> {
    const blocks = llmResponse.content as Array<ToolUseBlock | TextBlock>;
    const toolBlock = blocks.find((block) => block.type === "tool_use") as ToolUseBlock | undefined;
    if (!toolBlock) {
      const text = blocks
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      return { done: true, text: text || "Done.", observation: "" };
    }

    const command = String(toolBlock.input.command ?? "");
    const safety = enforceSafety(command, this.db, sessionId, []);

    if (!safety.allowed && safety.requiresApproval) {
      await createApprovalRequest(
        this.pendingApprovals,
        {
          sessionId,
          command,
          channel,
          threadTs
        },
        this.deps,
        this.env.SLACK_BOT_TOKEN,
        this.ctx.storage
      );
      return {
        done: true,
        text: "Paused pending approval.",
        observation: ""
      };
    }

    if (!safety.allowed) {
      return { done: true, text: safety.reason ?? "Blocked by safety policy.", observation: "" };
    }

    incrementRateLimit(this.db, "session", sessionId);
    const result = await this.executeWithGitSafety(command);

    if (result.exitCode === 0 && isCloudflareApplyCommand(command)) {
      await this.deps.postSlackMessage(
        this.env.SLACK_BOT_TOKEN,
        channel,
        "✅ Cloudflare update applied successfully. Your latest changes should now be effective.",
        threadTs
      );
    }

    const formatted = formatToolResult(toolBlock.id, [result.stdout, result.stderr].filter(Boolean).join("\n"));

    return {
      done: false,
      text: "",
      observation: JSON.stringify(formatted)
    };
  }

  private async executeWithRetry(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let lastResult: { stdout: string; stderr: string; exitCode: number } | undefined;
    for (let attempt = 0; attempt <= TOOL_RETRY_MAX; attempt++) {
      const result = await this.sandbox.exec(command);
      if (result.exitCode === 0) {
        return result;
      }
      lastResult = result;
      if (attempt < TOOL_RETRY_MAX) {
        const waitMs = TOOL_RETRY_BACKOFF_BASE_MS * Math.pow(1.5, attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }
    return lastResult!;
  }

  private async executeWithGitSafety(command: string) {
    const risky = /git\s+reset|rm\s+-rf|git\s+clean|-D\b/.test(command);
    if (risky) {
      await this.sandbox.exec('git add -A && git commit -m "checkpoint"');
    }

    const result = await this.executeWithRetry(command);

    if (result.exitCode !== 0 && risky) {
      await this.sandbox.exec("git reset --hard HEAD~1 || git reset --hard HEAD");
    }

    return result;
  }

  private async handleTaskEvent(event: SlackEvent): Promise<void> {
    const task = event.text ?? "";
    const threadTs = event.thread_ts ?? event.ts;
    const channel = event.channel;

    if (!threadTs || !channel || !task.trim()) {
      return;
    }

    await this.runAgentLoop(task, channel, threadTs);
  }

  private async handleApprovalReaction(event: SlackEvent): Promise<void> {
    await resolveApprovalReaction(
      event,
      this.pendingApprovals,
      this.deps,
      this.env.SLACK_BOT_TOKEN,
      this.db,
      async (command) => this.executeWithGitSafety(command)
    );
  }

  private async startSession(sessionId: string): Promise<void> {
    await restoreRepoSnapshot(this.env.REPO_STORE, sessionId, this.sandbox);
    await syncKnowledgeToSandbox(this.db, this.sandbox);
  }

  private async endSession(sessionId: string): Promise<void> {
    await Promise.all([
      saveRepoSnapshot(this.env.REPO_STORE, sessionId, this.sandbox),
      syncKnowledgeFromSandbox(this.db, this.sandbox)
    ]);
  }

  async alarm(): Promise<void> {
    await expireTimedOutApprovals(this.pendingApprovals, this.deps, this.env.SLACK_BOT_TOKEN, this.db);
  }
}
