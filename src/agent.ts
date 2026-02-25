import {
  MAX_STEPS,
  TOOL_RETRY_MAX,
  TOOL_RETRY_BACKOFF_BASE_MS,
  COMPACTION_TOKEN_THRESHOLD,
  SESSION_SUMMARY_RECENT_COUNT,
  THINKING_MESSAGE_DELAY_MS,
  BACKGROUND_TASK_INTERVAL_MS,
  MODEL_ROUTINE,
  MODEL_COMPLEX
} from "./config";
import { callLLM, type LLMResponse } from "./llm";
import { enforceSafety, isSelfModificationCommand } from "./safety";
import { SandboxClient, SANDBOX_ENV_FILE, type SandboxBinding } from "./sandbox-client";
import {
  compactMessagesInDB,
  completeHeartbeat,
  enqueueHeartbeat,
  failHeartbeat,
  getAllRecentAgentEvents,
  getHistory,
  getKnowledge,
  getNextPendingHeartbeat,
  getRecentAgentEvents,
  getRecentSessionSummaries,
  getCurrentSession,
  getModelSettings,
  setRoutineModel,
  setComplexModel,
  hasPendingHeartbeats,
  incrementRateLimit,
  initSchema,
  listHeartbeats,
  listActiveSubAgents,
  logAgentEvent,
  markSubAgentDone,
  registerSubAgent,
  resolveOrCreateSession,
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
import {
  BASH_TOOL,
  CREATE_TOOL_TOOL,
  compileDynamicToolCommand,
  dynamicToolToAnthropicSchema,
  formatToolResult,
  type DynamicToolDefinition,
  validateDynamicToolDefinition
} from "./tools";
import { mapChannelToDO, postApprovalRequest, postMessage } from "./slack";
import { createApprovalRequest, expireTimedOutApprovals, resolveApprovalReaction, type PendingApproval } from "./approval";
import type { ConversationMessage, Env, SlackEvent } from "./types";
import type { ToolResult } from "./types";

interface DurableObjectStateLike {
  waitUntil?: (promise: Promise<unknown>) => void;
  storage: {
    sql: SqlStorage;
    setAlarm?: (scheduledTime: number | Date) => Promise<void> | void;
  };
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
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

// Wraps a string in single quotes and escapes any embedded single quotes so it
// can be safely embedded in a shell script written to the sandbox env file.
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// DO name for the global logs channel – matches mapChannelToDO("__global__")
const GLOBAL_LOGS_DO_NAME = "slack-channel:__global__";
const SLOW_OPERATION_WARN_MS = 15_000;

const BASE_SYSTEM_PROMPT = [
  "You are Blob, a careful coding agent.",
  "Use tools when needed.",
  "The sandbox working directory is /workspace.",
  "Always use absolute paths (e.g. /workspace/repo) rather than bare directory names when referencing cloned repos.",
  "Each sandbox session starts fresh in /workspace — files from previous sessions are not automatically present.",
  "If a workflow repeats, use create_tool to define a reusable tool and then call it directly in later steps."
].join(" ");

function buildSystemPrompt(_knowledge: string, recentSummaries: SessionSummary[]): string {
  let prompt = BASE_SYSTEM_PROMPT;

  if (recentSummaries.length > 0) {
    const summariesText = recentSummaries.map((s) => s.summary).join("\n---\n");
    prompt += `\n\nContext from recent past conversations:\n${summariesText}`;
  }

  return prompt;
}


interface RuntimeModelSettings {
  routineModel: string;
  complexModel: string;
}

type SettingsCommand =
  | { type: "show" }
  | { type: "set"; target: "routine" | "complex"; model: string };

function parseSettingsCommand(rawText: string): SettingsCommand | null {
  const text = rawText.trim();
  if (!text) return null;

  if (/^(show|list)\s+(model\s+)?settings\??$/i.test(text)
    || /^what\s+are\s+my\s+model\s+settings\??$/i.test(text)) {
    return { type: "show" };
  }

  const setMatch = text.match(/^set\s+(routine|complex)\s+model\s+(?:to\s+)?(.+)$/i)
    ?? text.match(/^set\s+model\s+(routine|complex)\s+(?:to\s+)?(.+)$/i)
    ?? text.match(/^use\s+(.+)\s+for\s+(routine|complex)(?:\s+tasks?)?$/i);

  if (!setMatch) return null;

  let target: "routine" | "complex";
  let model: string;
  if (/^use\s+/i.test(text)) {
    model = setMatch[1].trim();
    target = setMatch[2].toLowerCase() as "routine" | "complex";
  } else {
    target = setMatch[1].toLowerCase() as "routine" | "complex";
    model = setMatch[2].trim();
  }

  if (!model) return null;
  return { type: "set", target, model };
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

interface MilestoneUpdate {
  message: string;
}

function detectMilestone(command: string, exitCode: number, stdout: string): MilestoneUpdate | null {
  const cmd = command.trim();

  // Git commit succeeded
  if (exitCode === 0 && /\bgit\s+commit\b/.test(cmd)) {
    const msgMatch = /(-m\s+["']([^"']+)["']|commit:\s+(.+))/.exec(cmd);
    const commitMsg = msgMatch?.[2] ?? msgMatch?.[3] ?? "changes";
    return { message: `Committed: ${commitMsg}` };
  }

  // Test runner results
  if (/\b(pytest|jest|vitest|npm\s+test|yarn\s+test)\b/.test(cmd)) {
    if (exitCode === 0) {
      return { message: `Tests passed` };
    }
    const failLine = stdout.split("\n").find((l) => /fail|error/i.test(l))?.trim() ?? "see output";
    return { message: `Tests failed: ${failLine}` };
  }

  return null;
}

function extractTextContent(response: LLMResponse): string {
  return (response.content as Array<TextBlock | ToolUseBlock>)
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function getToolUseIds(message: ConversationMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  return (message.content as Array<{ type?: string; id?: string }>)
    .filter((b): b is { type: "tool_use"; id: string } => b.type === "tool_use" && typeof b.id === "string")
    .map((b) => b.id);
}

function hasImmediateToolResults(message: ConversationMessage | undefined, requiredIds: string[]): boolean {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) {
    return false;
  }

  const resolvedIds = new Set(
    (message.content as Array<{ type?: string; tool_use_id?: string }>)
      .filter((b): b is { type: "tool_result"; tool_use_id: string } => b.type === "tool_result" && typeof b.tool_use_id === "string")
      .map((b) => b.tool_use_id)
  );

  return requiredIds.every((id) => resolvedIds.has(id));
}

function repairMissingToolResults(conversation: ConversationMessage[]): { messages: ConversationMessage[]; repaired: boolean } {
  const repairedMessages: ConversationMessage[] = [];
  let repaired = false;

  for (let i = 0; i < conversation.length; i += 1) {
    const current = conversation[i];
    repairedMessages.push(current);

    const toolUseIds = getToolUseIds(current);
    if (toolUseIds.length === 0) {
      continue;
    }

    const nextMessage = conversation[i + 1];
    if (hasImmediateToolResults(nextMessage, toolUseIds)) {
      continue;
    }

    repaired = true;
    repairedMessages.push({
      role: "user",
      content: toolUseIds.map((id) => formatToolResult(id, "Tool execution was interrupted before results were saved."))
    });
  }

  return { messages: repairedMessages, repaired };
}

export class AgentDO {
  private readonly db: SqlStorage;
  private readonly sandbox: SandboxClient;
  private readonly deps: AgentDeps;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly ctx: DurableObjectStateLike, private readonly env: Env, deps: Partial<AgentDeps> = {}) {
    this.db = ctx.storage.sql;
    this.sandbox = new SandboxClient((env.SANDBOX as unknown as SandboxBinding | undefined) ?? UNCONFIGURED_SANDBOX);
    this.deps = { ...DEFAULT_DEPS, ...deps };
    initSchema(this.db);
  }

  private logDiagnostic(sessionId: string, eventType: string, message: string, channel?: string): void {
    logAgentEvent(this.db, sessionId, eventType, message);
    if (channel) {
      this.forwardToGlobalLogs(eventType, `[#${channel}] ${message}`);
    }
  }

  private async traceOperation<T>(
    sessionId: string,
    label: string,
    operation: () => Promise<T>,
    channel?: string
  ): Promise<T> {
    const startedAt = this.deps.now();
    this.logDiagnostic(sessionId, "trace", `${label}: start`, channel);

    try {
      const result = await operation();
      const elapsedMs = this.deps.now() - startedAt;
      const eventType = elapsedMs >= SLOW_OPERATION_WARN_MS ? "trace_warning" : "trace";
      this.logDiagnostic(sessionId, eventType, `${label}: done in ${elapsedMs}ms`, channel);
      return result;
    } catch (error) {
      const elapsedMs = this.deps.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.logDiagnostic(sessionId, "trace_error", `${label}: failed after ${elapsedMs}ms (${message})`, channel);
      throw error;
    }
  }

  private runInBackground(work: Promise<void>): void {
    if (this.ctx.waitUntil) {
      this.ctx.waitUntil(work);
      return;
    }

    // Durable Object runtimes should expose waitUntil. If it is unavailable
    // (for example in local tests), do not block the request lifecycle.
    // Capture failures to avoid unhandled promise rejections in fire-and-forget mode.
    void work.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logAgentEvent(this.db, "global", "background_error", message);
      this.forwardToGlobalLogs("background_error", message);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as {
      action?: string;
      event?: SlackEvent;
      task?: string;
      channel?: string;
      eventType?: string;
      message?: string;
      orchestratorName?: string;
      doName?: string;
      status?: string;
      priorMessages?: ConversationMessage[];
      systemPrompt?: string;
      orchestratorSessionId?: string;
      finalText?: string;
    };

    if (body.action === "logs_snapshot") {
      const sessionId = getCurrentSession(this.db);
      // Global DO has no session; return all stored events instead of filtering by session
      const events = sessionId ? getRecentAgentEvents(this.db, sessionId) : getAllRecentAgentEvents(this.db);
      return Response.json({ events });
    }

    if (body.action === "logs_mirror" && body.event) {
      const { channel = "unknown", user = "", text = "" } = body.event;
      const msg = user ? `[#${channel}] <${user}> ${text}` : `[#${channel}] ${text}`;
      logAgentEvent(this.db, "global", "message", msg);
      return new Response("ok");
    }

    if (body.action === "log_event") {
      const eventType = body.eventType ?? "event";
      const message = body.message ?? "";
      logAgentEvent(this.db, "global", eventType, message);
      return new Response("ok");
    }

    if (body.action === "reaction" && body.event) {
      await this.handleApprovalReaction(body.event);
      // Broadcast the reaction to all active sub-agents so each agent can
      // handle its own pending approvals.
      const reactionChannel = body.event.item?.channel ?? body.event.channel;
      if (reactionChannel) {
        const activeSubAgents = listActiveSubAgents(this.db, reactionChannel);
        await Promise.allSettled(
          activeSubAgents.map(async (subAgentDoName) => {
            const subAgentId = this.env.AGENT_DO.idFromName(subAgentDoName);
            const subAgentStub = this.env.AGENT_DO.get(subAgentId);
            return subAgentStub.fetch("https://agent.internal/event", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "reaction", event: body.event })
            });
          })
        );
      }
      return new Response("ok");
    }

    if (body.action === "message" && body.event) {
      const event = body.event;
      this.runInBackground((async () => {
        try {
          const handled = await this.handleSettingsCommand(event);
          if (handled) {
            return;
          }
          await this.spawnSubAgent(event);
        } catch (error) {
          const channel = event.channel;
          if (channel) {
            const message = error instanceof Error ? error.message : "An unexpected error occurred.";
            await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, `Error: ${message}`);
          }
        }
      })());
      return new Response("accepted", { status: 202 });
    }

    if (body.action === "run_task" && body.event) {
      const event = body.event;
      const orchestratorName = String(body.orchestratorName ?? "");
      const doName = String(body.doName ?? "");
      const priorMessages = Array.isArray(body.priorMessages)
        ? (body.priorMessages as ConversationMessage[])
        : undefined;
      const systemPrompt = body.systemPrompt ? String(body.systemPrompt) : undefined;
      const orchestratorSessionId = body.orchestratorSessionId
        ? String(body.orchestratorSessionId)
        : undefined;
      this.runInBackground((async () => {
        let completionStatus: "completed" | "failed" = "completed";
        let finalText = "";
        try {
          finalText = await this.handleTaskEvent(event, priorMessages, systemPrompt);
        } catch (error) {
          completionStatus = "failed";
          const channel = event.channel;
          if (channel) {
            const message = error instanceof Error ? error.message : "An unexpected error occurred.";
            await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, `Error: ${message}`);
          }
        } finally {
          if (orchestratorName && doName) {
            const orchestratorId = this.env.AGENT_DO.idFromName(orchestratorName);
            const orchestratorStub = this.env.AGENT_DO.get(orchestratorId);
            void orchestratorStub.fetch("https://agent.internal/event", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "sub_agent_done",
                doName,
                status: completionStatus,
                finalText,
                orchestratorSessionId
              })
            }).catch(() => {});
          }
        }
      })());
      return new Response("accepted", { status: 202 });
    }

    if (body.action === "sub_agent_done" && body.doName) {
      const status = (body.status as "completed" | "failed") || "completed";
      markSubAgentDone(this.db, String(body.doName), status);
      // Persist the assistant's response into the orchestrator's conversation
      // history so the next message in this session sees the full exchange.
      const orchestratorSessionId = body.orchestratorSessionId
        ? String(body.orchestratorSessionId)
        : null;
      const finalText = body.finalText ? String(body.finalText) : null;
      if (orchestratorSessionId && finalText && status === "completed") {
        saveMessage(this.db, orchestratorSessionId, { role: "assistant", content: finalText });
      }
      return new Response("ok");
    }

    if (body.action === "enqueue_heartbeat" && body.task && body.channel) {
      const id = enqueueHeartbeat(this.db, body.task, body.channel);
      // Kick the queue immediately when a new heartbeat arrives so users don't
      // have to wait up to the full background interval before the first run.
      await this.ctx.storage.setAlarm?.(this.deps.now());
      return Response.json({ id });
    }

    if (body.action === "list_heartbeats") {
      return Response.json({ heartbeats: listHeartbeats(this.db) });
    }

    if (body.task && body.event?.channel) {
      this.runInBackground((async () => {
        const { sessionId, previousSessionId } = resolveOrCreateSession(this.db, this.deps.now());
        if (previousSessionId) {
          await this.summarizePreviousSession(previousSessionId);
        }
        await this.runAgentLoop(body.task!, body.event!.channel!, sessionId);
      })());
      return new Response("accepted", { status: 202 });
    }

    return new Response("bad request", { status: 400 });
  }


  private getRuntimeModelSettings(): RuntimeModelSettings {
    return getModelSettings(this.db, {
      routineModel: MODEL_ROUTINE,
      complexModel: MODEL_COMPLEX
    });
  }

  private async handleSettingsCommand(event: SlackEvent): Promise<boolean> {
    const channel = event.channel;
    const text = event.text ?? "";
    if (!channel) {
      return false;
    }

    const parsed = parseSettingsCommand(text);
    if (!parsed) {
      return false;
    }

    if (parsed.type === "show") {
      const settings = this.getRuntimeModelSettings();
      await this.deps.postSlackMessage(
        this.env.SLACK_BOT_TOKEN,
        channel,
        [
          "Current model settings:",
          `• routine: ${settings.routineModel}`,
          `• complex: ${settings.complexModel}`,
          "You can update by saying: set routine model to <model> or set complex model to <model>."
        ].join("\n")
      );
      return true;
    }

    if (parsed.target === "routine") {
      setRoutineModel(this.db, parsed.model);
    } else {
      setComplexModel(this.db, parsed.model);
    }

    const settings = this.getRuntimeModelSettings();
    await this.deps.postSlackMessage(
      this.env.SLACK_BOT_TOKEN,
      channel,
      [
        `Saved ${parsed.target} model: ${parsed.model}`,
        "Updated model settings:",
        `• routine: ${settings.routineModel}`,
        `• complex: ${settings.complexModel}`
      ].join("\n")
    );
    return true;
  }


  private buildLlmInput(overrides: {
    systemPrompt: string;
    messages: ConversationMessage[];
    tools?: unknown[];
    taskComplexityHint?: "routine" | "complex";
    model?: string;
  }): {
    apiKey?: string;
    openAiApiKey?: string;
    aiGatewayToken?: string;
    aiGatewayBaseUrl?: string;
    routineModel: string;
    complexModel: string;
    systemPrompt: string;
    messages: ConversationMessage[];
    tools?: unknown[];
    taskComplexityHint?: "routine" | "complex";
    model?: string;
  } {
    const settings = this.getRuntimeModelSettings();

    return {
      apiKey: this.env.ANTHROPIC_API_KEY,
      openAiApiKey: this.env.OPENAI_API_KEY,
      aiGatewayToken: this.env.AI_GATEWAY_TOKEN,
      aiGatewayBaseUrl: this.env.AI_GATEWAY_BASE_URL,
      routineModel: settings.routineModel,
      complexModel: settings.complexModel,
      ...overrides
    };
  }
  async runAgentLoop(
    task: string,
    channel: string,
    sessionId: string,
    options: {
      applySelfModificationRateLimit?: boolean;
      // When provided by an orchestrator, these replace the sub-agent's own
      // (empty) DB-derived values so the sub-agent has full conversation context.
      priorMessages?: ConversationMessage[];
      systemPrompt?: string;
    } = {}
  ): Promise<{ finalText: string; steps: number }> {
    const { applySelfModificationRateLimit = false } = options;

    logAgentEvent(this.db, sessionId, "task_received", task);
    this.forwardToGlobalLogs("task_received", `[#${channel}] ${task}`);

    // If the orchestrator supplied prior conversation messages use them directly;
    // otherwise fall back to loading from this DO's own DB (standalone / legacy path).
    let conversation: ConversationMessage[];
    if (options.priorMessages) {
      conversation = [...options.priorMessages];
    } else {
      // Load history and compact if the context is getting large
      const rawConversation = getHistory(this.db, sessionId);
      const compactedConversation = await this.compactConversationIfNeeded(rawConversation, sessionId);
      const repairedConversation = repairMissingToolResults(compactedConversation);
      conversation = repairedConversation.messages;
      if (repairedConversation.repaired) {
        // Persist repaired history to prevent recurring invalid Anthropic message order
        // errors in future turns for the same thread.
        compactMessagesInDB(this.db, sessionId, conversation);
      }
    }

    saveMessage(this.db, sessionId, { role: "user", content: task });
    conversation.push({ role: "user", content: task });

    // Sync runs in the background so it doesn't delay the LLM call.
    // The system prompt uses the knowledge already cached in the DB from the
    // previous sync; any external edits to AGENT.md will be picked up on the
    // next user message.
    void syncKnowledgeFromSandbox(this.db, this.sandbox);
    // Use the orchestrator-supplied system prompt when available (the sub-agent's
    // own DB is empty so its summaries/knowledge would be missing).
    const systemPrompt =
      options.systemPrompt ??
      buildSystemPrompt(
        getKnowledge(this.db),
        getRecentSessionSummaries(this.db, SESSION_SUMMARY_RECENT_COUNT)
      );
    const dynamicTools = new Map<string, DynamicToolDefinition>();

    let thinkingTimer: ReturnType<typeof setTimeout> | undefined;
    let thinkingMessagePromise: Promise<void> | null = null;
    thinkingTimer = setTimeout(() => {
      thinkingMessagePromise = this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, "Thinking...").then(() => {
        this.logDiagnostic(sessionId, "thinking", "Posted delayed thinking status.", channel);
      });
    }, THINKING_MESSAGE_DELAY_MS);

    const firstResponse = await this.traceOperation(
      sessionId,
      "llm_call_initial",
      () => this.deps.llmCall(this.buildLlmInput({
        systemPrompt,
        messages: conversation,
        tools: this.buildToolList(dynamicTools),
        taskComplexityHint: options.priorMessages ? "routine" : undefined
      })),
      channel
    );

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
          await this.traceOperation(sessionId, "sandbox_start", () => this.startSandboxSession(sessionId), channel);
          sandboxStarted = true;
          this.logDiagnostic(sessionId, "session", "Sandbox session started.", channel);
        }

        // Save the assistant's LLM response (including tool_use blocks) before execution
        conversation.push({ role: "assistant", content: llmResponse.content });
        saveMessage(this.db, sessionId, { role: "assistant", content: llmResponse.content });

        const decision = await this.processLlmResponse(llmResponse, channel, sessionId, {
          applySelfModificationRateLimit,
          dynamicTools
        });
        if (decision.observations.length > 0) {
          // Tool results are user-role messages in the Anthropic API, not assistant
          conversation.push({ role: "user", content: decision.observations });
          saveMessage(this.db, sessionId, { role: "user", content: decision.observations });
        }

        if (decision.done) {
          finalText = decision.text;
          break;
        }

        llmResponse = await this.traceOperation(
          sessionId,
          "llm_call_follow_up",
          () => this.deps.llmCall(this.buildLlmInput({
            systemPrompt,
            messages: conversation,
            tools: this.buildToolList(dynamicTools),
            taskComplexityHint: options.priorMessages ? "routine" : undefined
          })),
          channel
        );
      }
    } finally {
      if (sandboxStarted) {
        await this.traceOperation(sessionId, "sandbox_end", () => this.endSandboxSession(sessionId), channel);
        this.logDiagnostic(sessionId, "session", "Sandbox session ended.", channel);
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
    this.forwardToGlobalLogs("completed", `[#${channel}] ${finalText.slice(0, 300)}`);

    return { finalText, steps };
  }

  private forwardToGlobalLogs(eventType: string, message: string): void {
    // Fire-and-forget: mirror key agent events to the global DO for the live logs page
    const id = this.env.AGENT_DO.idFromName(GLOBAL_LOGS_DO_NAME);
    const stub = this.env.AGENT_DO.get(id);
    void stub.fetch("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "log_event", eventType, message })
    }).catch(() => {
      // Non-critical logging; silently discard errors
    });
  }

  private async processLlmResponse(
    llmResponse: LLMResponse,
    channel: string,
    sessionId: string,
    options: {
      applySelfModificationRateLimit: boolean;
      dynamicTools: Map<string, DynamicToolDefinition>;
    }
  ): Promise<{ done: boolean; text: string; observations: ToolResult[] }> {
    const blocks = llmResponse.content as Array<ToolUseBlock | TextBlock>;
    const toolBlock = blocks.find((block) => block.type === "tool_use") as ToolUseBlock | undefined;
    if (!toolBlock) {
      const text = blocks
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      return { done: true, text: text || "Done.", observations: [] };
    }

    const observations: ToolResult[] = [];
    let done = false;
    let doneText = "";

    const toolBlocks = blocks.filter((block): block is ToolUseBlock => block.type === "tool_use");
    for (let i = 0; i < toolBlocks.length; i++) {
      const toolBlock = toolBlocks[i];

      if (done) {
        observations.push(formatToolResult(toolBlock.id, "Skipped: agent execution already paused."));
        continue;
      }

      if (toolBlock.name === CREATE_TOOL_TOOL.name) {
        const validation = validateDynamicToolDefinition(toolBlock.input);
        const toolResult = validation.ok
          ? (() => {
              options.dynamicTools.set(validation.definition.name, validation.definition);
              return `Created tool \"${validation.definition.name}\" with args: ${validation.definition.args.join(", ") || "(none)"}.`;
            })()
          : `Tool creation failed: ${validation.reason}`;

        observations.push(formatToolResult(toolBlock.id, toolResult));
        continue;
      }

      const dynamicTool = options.dynamicTools.get(toolBlock.name);
      const commandResult = dynamicTool
        ? compileDynamicToolCommand(dynamicTool, toolBlock.input)
        : { ok: true as const, command: String(toolBlock.input.command ?? "") };

      if (!commandResult.ok) {
        observations.push(formatToolResult(toolBlock.id, `Tool execution failed: ${commandResult.reason}`));
        continue;
      }

      const command = commandResult.command.trim();
      if (!command) {
        const warning = "Tool execution failed: empty command generated. Please provide a non-empty command.";
        logAgentEvent(this.db, sessionId, "trace_warning", warning);
        this.forwardToGlobalLogs("trace_warning", `[#${channel}] ${warning}`);
        observations.push(formatToolResult(toolBlock.id, warning));
        continue;
      }

      const sanitizedCommand = this.sanitizeSecrets(command);
      logAgentEvent(this.db, sessionId, "command", sanitizedCommand);
      this.forwardToGlobalLogs("command", `[#${channel}] ${sanitizedCommand}`);
      const safety = enforceSafety(command, this.db, sessionId, [], {
        applySelfModificationRateLimit: options.applySelfModificationRateLimit
      });

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
        observations.push(formatToolResult(toolBlock.id, "Paused pending approval."));
        done = true;
        doneText = "Paused pending approval.";
        continue;
      }

      if (!safety.allowed) {
        const blockedReason = safety.reason ?? "Blocked by safety policy.";
        observations.push(formatToolResult(toolBlock.id, blockedReason));
        done = true;
        doneText = blockedReason;
        continue;
      }

      if (options.applySelfModificationRateLimit && isSelfModificationCommand(command)) {
        incrementRateLimit(this.db, "session", sessionId);
        const todayKey = new Date().toISOString().slice(0, 10);
        incrementRateLimit(this.db, "day", todayKey);
      }
      const result = await this.traceOperation(sessionId, "command_exec", () => this.executeWithGitSafety(command), channel);
      if (result.stdout.trim()) {
        const rawStdout = result.stdout.length > 4000 ? `${result.stdout.slice(0, 4000)}\n...[truncated]` : result.stdout;
        const stdoutMessage = this.sanitizeSecrets(rawStdout);
        logAgentEvent(this.db, sessionId, "command_output", stdoutMessage);
        this.forwardToGlobalLogs("command_output", `[#${channel}] ${stdoutMessage}`);
      }

      if (result.stderr.trim()) {
        const rawStderr = result.stderr.length > 4000 ? `${result.stderr.slice(0, 4000)}\n...[truncated]` : result.stderr;
        const stderrMessage = this.sanitizeSecrets(rawStderr);
        logAgentEvent(this.db, sessionId, "command_error", stderrMessage);
        this.forwardToGlobalLogs("command_error", `[#${channel}] ${stderrMessage}`);
      }

      const exitSummary = `Command finished with exit code ${result.exitCode}.`;
      const exitEventType = result.exitCode === 0 ? "command_success" : "command_failure";
      logAgentEvent(this.db, sessionId, exitEventType, exitSummary);
      this.forwardToGlobalLogs(exitEventType, `[#${channel}] ${exitSummary}`);

      if (result.exitCode === 0 && isCloudflareApplyCommand(command)) {
        await this.deps.postSlackMessage(
          this.env.SLACK_BOT_TOKEN,
          channel,
          "✅ Cloudflare update applied successfully. Your latest changes should now be effective."
        );
      }

      const milestone = detectMilestone(command, result.exitCode, result.stdout);
      if (milestone) {
        await this.deps.postSlackMessage(this.env.SLACK_BOT_TOKEN, channel, milestone.message);
      }

      const toolOutput = this.sanitizeSecrets([result.stdout, result.stderr].filter(Boolean).join("\n"));
      observations.push(formatToolResult(toolBlock.id, toolOutput));
    }

    return {
      done,
      text: doneText,
      observations
    };
  }

  private buildToolList(dynamicTools: Map<string, DynamicToolDefinition>): unknown[] {
    return [BASH_TOOL, CREATE_TOOL_TOOL, ...Array.from(dynamicTools.values()).map((tool) => dynamicToolToAnthropicSchema(tool))];
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

  private async handleTaskEvent(
    event: SlackEvent,
    priorMessages?: ConversationMessage[],
    systemPrompt?: string
  ): Promise<string> {
    const task = event.text ?? "";
    const channel = event.channel;

    if (!channel || !task.trim()) {
      return "";
    }

    // The sub-agent uses its own session only for internal tracking (sandbox,
    // agent events). Session lifecycle and conversation memory are managed by
    // the orchestrator; no previous-session summarisation is needed here.
    const { sessionId } = resolveOrCreateSession(this.db, this.deps.now());

    const { finalText } = await this.runAgentLoop(task, channel, sessionId, {
      priorMessages,
      systemPrompt,
    });
    return finalText;
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

  // Spawns a dedicated sub-agent Durable Object instance to handle a single
  // Slack task, enabling multiple tasks to run concurrently. The orchestrator
  // (per-channel DO) registers the sub-agent so that subsequent reactions can
  // be routed to all active sub-agents for that channel.
  private async spawnSubAgent(event: SlackEvent): Promise<void> {
    const channel = event.channel;
    const task = event.text?.trim();
    if (!channel || !task) {
      return;
    }

    // Orchestrator owns session lifecycle and conversation memory.
    // It resolves (or creates) the current session, handles end-of-session
    // summarisation, and passes the accumulated history to the ephemeral
    // sub-agent so the sub-agent starts with full conversation context.
    const { sessionId, previousSessionId } = resolveOrCreateSession(this.db, this.deps.now());
    if (previousSessionId) {
      await this.traceOperation(
        sessionId,
        "session_summary",
        () => this.summarizePreviousSession(previousSessionId),
        channel
      );
    }

    // Build the system prompt here using the orchestrator's own summaries so
    // the sub-agent receives an accurate prompt even though its own DB is empty.
    const summaries = getRecentSessionSummaries(this.db, SESSION_SUMMARY_RECENT_COUNT);
    const systemPrompt = buildSystemPrompt(getKnowledge(this.db), summaries);

    // Snapshot the history *before* appending the new user message so that
    // runAgentLoop on the sub-agent can append it itself (preserving the
    // existing load-then-append pattern).
    const priorMessages = getHistory(this.db, sessionId);

    // Persist the incoming user message on the orchestrator side now so that
    // even if the sub-agent crashes the turn is recorded.
    saveMessage(this.db, sessionId, { role: "user", content: task });

    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const subAgentDoName = `task-agent:${channel}:${uniqueSuffix}`;
    const orchestratorName = mapChannelToDO(channel);

    registerSubAgent(this.db, channel, subAgentDoName);
    this.forwardToGlobalLogs("sub_agent_spawned", `[#${channel}] Spawned sub-agent: ${subAgentDoName}`);

    const subAgentId = this.env.AGENT_DO.idFromName(subAgentDoName);
    const subAgentStub = this.env.AGENT_DO.get(subAgentId);
    await subAgentStub.fetch("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "run_task",
        event,
        orchestratorName,
        doName: subAgentDoName,
        // Conversation context from the orchestrator
        priorMessages,
        systemPrompt,
        orchestratorSessionId: sessionId
      })
    });
  }

  private async startSandboxSession(sessionId: string): Promise<void> {
    await this.sandbox.warmUp();
    await restoreRepoSnapshot(this.env.REPO_STORE, sessionId, this.sandbox);
    await syncKnowledgeToSandbox(this.db, this.sandbox);
    await this.injectSecretsIntoSandbox();
  }

  // Writes Cloudflare secrets that the sandbox container needs (e.g. GITHUB_TOKEN)
  // to a sourced env file so they are available to every command executed in the
  // sandbox without being embedded in individual command strings.
  private async injectSecretsIntoSandbox(): Promise<void> {
    const lines: string[] = [];
    // Prevent git from trying to open /dev/tty for interactive credential prompts,
    // which causes "No such device or address" errors in non-TTY sandbox environments.
    lines.push("export GIT_TERMINAL_PROMPT=0");
    if (this.env.GITHUB_TOKEN) {
      lines.push(`export GITHUB_TOKEN=${shellEscape(this.env.GITHUB_TOKEN)}`);
    }
    if (this.env.GITHUB_USERNAME) {
      lines.push(`export GITHUB_USERNAME=${shellEscape(this.env.GITHUB_USERNAME)}`);
    }
    await this.sandbox.writeFile(SANDBOX_ENV_FILE, lines.join("\n") + "\n");
  }

  // Replace any known secret values with a placeholder so they are never written
  // to logs or forwarded to external channels (e.g. Slack, global log DO).
  private sanitizeSecrets(text: string): string {
    let result = text;
    const token = this.env.GITHUB_TOKEN;
    if (token && token.length > 8) {
      result = result.split(token).join("[GITHUB_TOKEN]");
    }
    return result;
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
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role === "user" ? "User" : "Blob"}: ${content}`;
      })
      .join("\n\n");

    const currentKnowledge = getKnowledge(this.db);

    const response = await this.deps.llmCall(this.buildLlmInput({
      taskComplexityHint: "routine",
      model: this.getRuntimeModelSettings().routineModel,
      systemPrompt: "You maintain concise memory between AI agent sessions.",
      messages: [
        {
          role: "user",
          content: [
            "A conversation just ended. Please:",
            "1. Write a SUMMARY (2-4 sentences) of what was accomplished.",
            "2. Write UPDATED_AGENT_MD with the complete updated long-term memory,",
            "   merging any important new facts (preferences, patterns, capabilities)",
            "   into the existing content -- or write exactly \"(unchanged)\" if nothing",
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
    }));

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
      (sum, m) => {
        const len = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
        return sum + Math.ceil(len / 4);
      },
      0
    );

    if (estimatedTokens <= COMPACTION_TOKEN_THRESHOLD || conversation.length <= KEEP_RECENT) {
      return conversation;
    }

    const toCompact = conversation.slice(0, -KEEP_RECENT);
    const toKeep = conversation.slice(-KEEP_RECENT);

    const history = toCompact
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role === "user" ? "User" : "Blob"}: ${content}`;
      })
      .join("\n\n");

    const response = await this.deps.llmCall(this.buildLlmInput({
      taskComplexityHint: "routine",
      model: this.getRuntimeModelSettings().routineModel,
      systemPrompt: "Summarise conversation history concisely, preserving key decisions, code changes, and context.",
      messages: [{ role: "user", content: `Summarise:

${history}` }]
    }));

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
    await this.runInBackground((async () => {
      await expireTimedOutApprovals(this.pendingApprovals, this.deps, this.env.SLACK_BOT_TOKEN, this.db);
      await this.processNextHeartbeat();
    })());
  }

  private async processNextHeartbeat(): Promise<void> {
    const heartbeat = getNextPendingHeartbeat(this.db);
    if (!heartbeat) return;

    logAgentEvent(this.db, heartbeat.id.toString(), "heartbeat_start", heartbeat.task);
    this.forwardToGlobalLogs("heartbeat_start", `[#${heartbeat.channel}] ${heartbeat.task}`);

    try {
      const { sessionId, previousSessionId } = resolveOrCreateSession(this.db, this.deps.now());
      if (previousSessionId) {
        await this.summarizePreviousSession(previousSessionId);
      }
      const { finalText } = await this.runAgentLoop(heartbeat.task, heartbeat.channel, sessionId, {
        applySelfModificationRateLimit: true
      });
      completeHeartbeat(this.db, heartbeat.id, finalText);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failHeartbeat(this.db, heartbeat.id, errorMessage);
      await this.deps.postSlackMessage(
        this.env.SLACK_BOT_TOKEN,
        heartbeat.channel,
        `Heartbeat failed: ${errorMessage}`
      );
    }

    // Re-schedule the alarm if more heartbeats are queued
    if (hasPendingHeartbeats(this.db)) {
      await this.ctx.storage.setAlarm?.(this.deps.now() + BACKGROUND_TASK_INTERVAL_MS);
    }
  }
}
