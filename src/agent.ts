import { Agent } from "@cloudflare/agents";
import {
  MAX_STEPS,
  TOOL_RETRY_MAX,
  TOOL_RETRY_BACKOFF_BASE_MS,
  COMPACTION_TOKEN_THRESHOLD,
  SESSION_SUMMARY_RECENT_COUNT,
  THINKING_MESSAGE_DELAY_MS
} from "./config";
import { callLLM, type LLMResponse } from "./llm";
import { enforceSafety } from "./safety";
import { SandboxClient, type SandboxBinding } from "./sandbox-client";
import {
  compactMessagesInDB,
  completeBackgroundTask,
  claimNextBackgroundTask,
  enqueueBackgroundTask,
  failBackgroundTask,
  getHeartbeatGoal,
  getHistory,
  getKnowledge,
  getRecentAgentEvents,
  getRecentSessionSummaries,
  getCurrentSession,
  incrementRateLimit,
  initSchema,
  logAgentEvent,
  resolveOrCreateSession,
  saveHeartbeatGoal,
  restoreRepoSnapshot,
  saveKnowledge,
  saveMessage,
  saveRepoSnapshot,
  saveSessionSummary,
  syncKnowledgeFromSandbox,
  syncKnowledgeToSandbox,
  type SessionSummary,
  type SqlStorage
} from "./storage";
import { BASH_TOOL, formatToolResult } from "./tools";
import { postApprovalRequest, postMessage } from "./slack";
import { createApprovalRequest, expireTimedOutApprovals, resolveApprovalReaction, type PendingApproval } from "./approval";
import type { ConversationMessage, Env, SlackEvent } from "./types";

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

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

const BASE_SYSTEM_PROMPT = [
  "You are Blob, a careful coding agent.",
  "Use tools when needed."
].join(" ");

function buildSystemPrompt(knowledge: string, recentSummaries: SessionSummary[]): string {
  let prompt = BASE_SYSTEM_PROMPT;

  const trimmedKnowledge = knowledge.trim();
  if (trimmedKnowledge) {
    prompt += `\n\nFollow this AGENT.md knowledge when relevant:\n${trimmedKnowledge}`;
  }

  if (recentSummaries.length > 0) {
    const summariesText = recentSummaries.map((s) => s.summary).join("\n---\n");
    prompt += `\n\nContext from recent past conversations:\n${summariesText}`;
  }

  return prompt;
}

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

function extractTextContent(response: LLMResponse): string {
  return (response.content as Array<TextBlock | ToolUseBlock>)
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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

    if (body.action === "logs_snapshot") {
      const sessionId = getCurrentSession(this.db);
      return Response.json({ events: sessionId ? getRecentAgentEvents(this.db, sessionId) : [] });
    }

    if (body.action === "reaction" && body.event) {
      await this.handleApprovalReaction(body.event);
      return new Response("ok");
    }

    if (body.action === "message" && body.event) {
      const event = body.event;
      if (this.ctx.storage.setAlarm) {
        const task = event.text ?? "";
        const channel = event.channel;
        if (channel && task.trim()) {
          enqueueBackgroundTask(this.db, event);
          saveHeartbeatGoal(this.db, channel, task);
          const eventThreadId = event.thread_ts ?? event.ts ?? channel;
          logAgentEvent(this.db, eventThreadId, "heartbeat_queued", "Task queued for heartbeat processing.");
          await this.ctx.storage.setAlarm(this.deps.now());
        }
      } else {
        try {
          await this.handleTaskEvent(event);
        } catch (error) {
          const channel = event.channel;
          if (channel) {
            const message = error instanceof Error ? error.message : "An unexpected error occurred.";
            await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, `Error: ${message}`);
          }
        }
      }
      return new Response("accepted", { status: 202 });
    }

    if (body.task && body.event?.channel) {
      const { sessionId, previousSessionId } = resolveOrCreateSession(this.db, this.deps.now());
      if (previousSessionId) {
        await this.summarizePreviousSession(previousSessionId);
      }
      await this.runAgentLoop(body.task, body.event.channel, sessionId);
      return new Response("accepted", { status: 202 });
    }

    return new Response("bad request", { status: 400 });
  }

  async runAgentLoop(task: string, channel: string, sessionId: string): Promise<{ finalText: string; steps: number }> {
    logAgentEvent(this.db, sessionId, "task_received", task);

    // Load history and compact if the context is getting large
    const rawConversation = getHistory(this.db, sessionId);
    const conversation = await this.compactConversationIfNeeded(rawConversation, sessionId);

    saveMessage(this.db, sessionId, { role: "user", content: task });
    conversation.push({ role: "user", content: task });

    await syncKnowledgeFromSandbox(this.db, this.sandbox);
    const summaries = getRecentSessionSummaries(this.db, SESSION_SUMMARY_RECENT_COUNT);
    const systemPrompt = buildSystemPrompt(getKnowledge(this.db), summaries);

    let thinkingTimer: ReturnType<typeof setTimeout> | undefined;
    let thinkingMessagePromise: Promise<void> | null = null;
    thinkingTimer = setTimeout(() => {
      thinkingMessagePromise = this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, "Thinking...").then(() => {
        logAgentEvent(this.db, sessionId, "thinking", "Posted delayed thinking status.");
      });
    }, THINKING_MESSAGE_DELAY_MS);

    const firstResponse = await this.deps.llmCall({
      apiKey: this.env.ANTHROPIC_API_KEY,
      systemPrompt,
      messages: conversation,
      tools: [BASH_TOOL]
    });

    let finalText = "";
    let steps = 0;
    let sandboxStarted = false;
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

        if (!sandboxStarted) {
          await this.startSandboxSession(sessionId);
          sandboxStarted = true;
          logAgentEvent(this.db, sessionId, "session", "Sandbox session started.");
        }

        const decision = await this.processLlmResponse(llmResponse, channel, sessionId);
        if (decision.done) {
          finalText = decision.text;
          break;
        }

        conversation.push({ role: "assistant", content: decision.observation });
        saveMessage(this.db, sessionId, { role: "assistant", content: decision.observation });

        llmResponse = await this.deps.llmCall({
          apiKey: this.env.ANTHROPIC_API_KEY,
          systemPrompt,
          messages: conversation,
          tools: [BASH_TOOL]
        });
      }
    } finally {
      if (sandboxStarted) {
        await this.endSandboxSession(sessionId);
        logAgentEvent(this.db, sessionId, "session", "Sandbox session ended.");
      }
    }

    if (!finalText) {
      finalText = `Stopped after reaching max steps (${MAX_STEPS}).`;
    }

    if (thinkingTimer) {
      clearTimeout(thinkingTimer);
    }
    if (thinkingMessagePromise) {
      await thinkingMessagePromise;
    }

    await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, finalText);
    logAgentEvent(this.db, sessionId, "completed", finalText);

    return { finalText, steps };
  }

  private async processLlmResponse(
    llmResponse: LLMResponse,
    channel: string,
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
    logAgentEvent(this.db, sessionId, "command", command);
    const safety = enforceSafety(command, this.db, sessionId, []);

    if (!safety.allowed && safety.requiresApproval) {
      await createApprovalRequest(
        this.pendingApprovals,
        {
          sessionId,
          command,
          channel
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
    const exitSummary = `Command finished with exit code ${result.exitCode}.`;
    logAgentEvent(this.db, sessionId, result.exitCode === 0 ? "command_success" : "command_failure", exitSummary);

    if (result.exitCode === 0 && isCloudflareApplyCommand(command)) {
      await this.deps.postSlackMessage(
        this.env.SLACK_BOT_TOKEN,
        channel,
        "✅ Cloudflare update applied successfully. Your latest changes should now be effective."
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
    const channel = event.channel;

    if (!channel || !task.trim()) {
      return;
    }

    const { sessionId, previousSessionId } = resolveOrCreateSession(this.db, this.deps.now());

    // When a new conversation starts, summarize the previous one and extract
    // any long-term learnings into AGENT.md before the new session runs
    if (previousSessionId) {
      await this.summarizePreviousSession(previousSessionId);
    }

    await this.runAgentLoop(task, channel, sessionId);
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

  private async startSandboxSession(sessionId: string): Promise<void> {
    await restoreRepoSnapshot(this.env.REPO_STORE, sessionId, this.sandbox);
    await syncKnowledgeToSandbox(this.db, this.sandbox);
  }

  private async endSandboxSession(sessionId: string): Promise<void> {
    await Promise.all([
      saveRepoSnapshot(this.env.REPO_STORE, sessionId, this.sandbox),
      syncKnowledgeFromSandbox(this.db, this.sandbox)
    ]);
  }

  // Mechanism 4: end-of-conversation episodic + semantic memory
  // Called at the start of a new conversation when a previous session timed out.
  // Writes a summary to session_summaries (episodic) and merges any new facts
  // into AGENT.md / the knowledge table (semantic).
  private async summarizePreviousSession(previousSessionId: string): Promise<void> {
    const messages = getHistory(this.db, previousSessionId);
    if (messages.length === 0) return;

    const history = messages
      .map((m) => `${m.role === "user" ? "User" : "Blob"}: ${m.content}`)
      .join("\n\n");

    const currentKnowledge = getKnowledge(this.db);

    const response = await this.deps.llmCall({
      apiKey: this.env.ANTHROPIC_API_KEY,
      taskComplexityHint: "routine",
      systemPrompt: "You maintain concise memory between AI agent sessions.",
      messages: [
        {
          role: "user",
          content: [
            "A conversation just ended. Please:",
            "1. Write a SUMMARY (2-4 sentences) of what was accomplished.",
            "2. Write UPDATED_AGENT_MD with the complete updated long-term memory,",
            "   merging any important new facts (preferences, patterns, capabilities)",
            "   into the existing content — or write exactly \"(unchanged)\" if nothing",
            "   needs to be added. Do not duplicate existing content.",
            "",
            `Current AGENT.md:\n${currentKnowledge || "(empty)"}`,
            "",
            `Conversation:\n${history}`,
            "",
            "Respond in exactly this format:",
            "SUMMARY: <your summary here>",
            "UPDATED_AGENT_MD:",
            "<full content or (unchanged)>"
          ].join("\n")
        }
      ]
    });

    const text = extractTextContent(response);
    const lines = text.split("\n");

    const summaryStart = lines.findIndex((l) => l.startsWith("SUMMARY:"));
    const mdStart = lines.findIndex((l) => l.startsWith("UPDATED_AGENT_MD:"));

    const summary =
      summaryStart >= 0
        ? lines
            .slice(summaryStart, mdStart >= 0 ? mdStart : undefined)
            .join("\n")
            .replace(/^SUMMARY:\s*/m, "")
            .trim()
        : text.slice(0, 400).trim();

    if (summary) {
      saveSessionSummary(this.db, previousSessionId, summary);
    }

    const updatedMd =
      mdStart >= 0 ? lines.slice(mdStart + 1).join("\n").trim() : "";

    if (updatedMd && updatedMd !== "(unchanged)") {
      saveKnowledge(this.db, updatedMd);
    }
  }

  // Mechanism 3: in-session context compaction
  // When estimated token count of the conversation exceeds the threshold,
  // the oldest messages are summarised and replaced with a single context
  // message so the active window stays manageable.
  private async compactConversationIfNeeded(
    conversation: ConversationMessage[],
    sessionId: string
  ): Promise<ConversationMessage[]> {
    const KEEP_RECENT = 6;
    const estimatedTokens = conversation.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0
    );

    if (estimatedTokens <= COMPACTION_TOKEN_THRESHOLD || conversation.length <= KEEP_RECENT) {
      return conversation;
    }

    const toCompact = conversation.slice(0, -KEEP_RECENT);
    const toKeep = conversation.slice(-KEEP_RECENT);

    const history = toCompact
      .map((m) => `${m.role === "user" ? "User" : "Blob"}: ${m.content}`)
      .join("\n\n");

    const response = await this.deps.llmCall({
      apiKey: this.env.ANTHROPIC_API_KEY,
      taskComplexityHint: "routine",
      systemPrompt: "Summarise conversation history concisely, preserving key decisions, code changes, and context.",
      messages: [{ role: "user", content: `Summarise:\n\n${history}` }]
    });

    const summaryText = extractTextContent(response) || "(context summarised)";
    const summaryMessage: ConversationMessage = {
      role: "user",
      content: `[Earlier context, compacted]: ${summaryText}`
    };

    const compacted = [summaryMessage, ...toKeep];
    compactMessagesInDB(this.db, sessionId, compacted);

    return compacted;
  }

  async alarm(): Promise<void> {
    const nextTask = claimNextBackgroundTask(this.db);
    if (nextTask) {
      try {
        await this.handleTaskEvent(nextTask.event);
        completeBackgroundTask(this.db, nextTask.id);
      } catch (error) {
        failBackgroundTask(this.db, nextTask.id);
        const message = error instanceof Error ? error.message : "An unexpected error occurred.";
        if (nextTask.event.channel) {
          await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, nextTask.event.channel, `Error: ${message}`);
        }
      }
    } else {
      const heartbeatGoal = getHeartbeatGoal(this.db);
      if (heartbeatGoal) {
        const heartbeatEvent: SlackEvent = {
          type: "message",
          channel: heartbeatGoal.channel,
          text: `Heartbeat: continue working toward this goal: ${heartbeatGoal.goal}`
        };
        logAgentEvent(this.db, heartbeatGoal.channel, "heartbeat", "Running scheduled heartbeat toward goal.");
        try {
          await this.handleTaskEvent(heartbeatEvent);
        } catch (error) {
          const message = error instanceof Error ? error.message : "An unexpected error occurred.";
          await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, heartbeatGoal.channel, `Heartbeat error: ${message}`);
        }
      }
    }

    await expireTimedOutApprovals(this.pendingApprovals, this.deps, this.env.SLACK_BOT_TOKEN, this.db);

    if (this.ctx.storage.setAlarm) {
      await this.ctx.storage.setAlarm(this.deps.now() + HEARTBEAT_INTERVAL_MS);
    }
  }
}
