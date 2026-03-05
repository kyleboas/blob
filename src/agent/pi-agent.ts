import type { Env } from "../core/types";
import { DEFAULT_MODEL } from "../core/models";
import { appendWorkspaceState, editTool, ensureSandboxSession, executeInSandbox, readTool, writeTool } from "../integrations/sandbox";
import { logEvent } from "../core/observability";
import {
  appendLearnedRecord,
  buildSemanticMemoryContext,
  flushLearnedRecordsToR2,
  querySemanticMemory,
  updateLearnedMemoryStatus,
  updateVectorizeMemoryStatus,
  upsertSemanticMemory,
} from "../core/memory";

interface PiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ToolCall {
  tool: "read" | "write" | "edit" | "bash";
  args: Record<string, unknown>;
}

interface LLMToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
}

interface ToolResult {
  output: string;
  error?: string;
}

interface RunOptions {
  sandboxId?: string;
  critical?: boolean;
  onProgress?: (message: string) => Promise<void> | void;
  onToolLedger?: (entry: { tool: ToolCall["tool"]; argsSummary: string; ok: boolean; durationMs: number; error?: string }) => Promise<void> | void;
  verbosity?: "minimal" | "verbose";
  conversationHistory?: Array<{ role: string; content: string }>;
  conversationKey?: string;
}

interface SelfTestOptions {
  sandboxId?: string;
  onProgress?: (message: string) => Promise<void> | void;
  verbosity?: "minimal" | "verbose";
  conversationKey?: string;
}


interface BudgetState {
  inputTokens: number;
  outputTokens: number;
  warned: boolean;
  halted: boolean;
}

const dailyTokenUsageLocal = new Map<string, number>();

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("timeout") || lower.includes("econn") || lower.includes("temporar") || lower.includes("503");
}

function parseToolCall(response: string): ToolCall | null {
  const toolMatch = response.match(/^\s*TOOL:\s*(\w+)\s*$/im);
  const argMatch = response.match(/^\s*ARG:\s*([\s\S]+)$/im);
  if (!toolMatch) return null;

  const tool = toolMatch[1] as ToolCall["tool"];
  if (!["read", "write", "edit", "bash"].includes(tool)) {
    return null;
  }

  let args: Record<string, unknown> = {};
  if (argMatch) {
    try {
      args = JSON.parse(argMatch[1].trim());
    } catch {
      args = { raw: argMatch[1].trim() };
    }
  }

  return { tool, args };
}

function parseStructuredToolCall(call: LLMToolCall): ToolCall | null {
  const tool = call.function.name as ToolCall["tool"];
  if (!tool || !["read", "write", "edit", "bash"].includes(tool)) {
    return null;
  }

  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { tool, args: {} };
    }
    return { tool, args: parsed as Record<string, unknown> };
  } catch {
    return { tool, args: {} };
  }
}

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a UTF-8 text file from the repository workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write UTF-8 text content to a file in the repository workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace exact oldText with newText in a file in the repository workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
        required: ["path", "oldText", "newText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the repository workspace.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
] as const;

function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${summarizeText(String(value), 80)}`);
  return parts.join(", ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function summarizeText(text: string, maxChars = 300): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}

function buildBootstrapScript(repoDir: string, repo: string): string {
  const workspaceRoot = `/workspace/${repoDir}`;
  const hasRepoSlug = repo.includes("/");
  const cloneUrl = hasRepoSlug ? `https://github.com/${repo}.git` : "";
  const cloneStep = hasRepoSlug
    ? `    git clone ${shellQuote(cloneUrl)} ${shellQuote(workspaceRoot)}\n`
    : `    mkdir -p ${shellQuote(workspaceRoot)}\n`;

  return `set -eu
mkdir -p /workspace
if [ -d ${shellQuote(`${workspaceRoot}/.git`)} ]; then
  cd ${shellQuote(workspaceRoot)}
  git fetch --prune origin
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    git reset --hard origin/main
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    git reset --hard origin/master
  else
    git pull --ff-only
  fi
else
${cloneStep}  if [ -d ${shellQuote(`${workspaceRoot}/.git`)} ]; then
    cd ${shellQuote(workspaceRoot)}
    if git show-ref --verify --quiet refs/remotes/origin/main; then
      git checkout -B main origin/main
    elif git show-ref --verify --quiet refs/remotes/origin/master; then
      git checkout -B master origin/master
    fi
  fi
fi`;
}

export class PiAgent {
  private messages: PiMessage[];
  private repoDir: string;

  constructor(
    private env: Env,
    private repo: string,
  ) {
    // repo may be "owner/name" but the sandbox clones into /workspace/<name>
    this.repoDir = repo.includes("/") ? repo.split("/").pop()! : repo;
    this.messages = [{ role: "system", content: this.buildSystemPrompt() }];
  }

  private buildSystemPrompt(): string {
    return `You are a versatile assistant with access to a workspace at /workspace/${this.repoDir}.

You have 4 tools — read, write, edit, bash — which together give you full capability to accomplish any task. The bash tool lets you run arbitrary commands: install packages, fetch URLs, run scripts, use git, compile code, query APIs, and anything else a Linux shell can do. Never say you cannot do something — figure out how to accomplish it with your tools.

When calling tools, output exactly:\nTOOL: <name>\nARG: <json>
Stop when done and provide a concise summary.`;
  }

  private async ensureRepoBootstrapped(
    sandboxId: string,
    onProgress?: RunOptions["onProgress"],
    verbosity: RunOptions["verbosity"] = "minimal",
  ): Promise<void> {
    await ensureSandboxSession(sandboxId, this.env);

    const authPrefix = this.env.GITHUB_TOKEN
      ? [
          `export GITHUB_TOKEN=${shellQuote(this.env.GITHUB_TOKEN)}`,
          "export GIT_ASKPASS=/usr/local/bin/blob-git-askpass",
          "export GIT_TERMINAL_PROMPT=0",
          `git config --global url.${shellQuote(`https://x-access-token:${encodeURIComponent(this.env.GITHUB_TOKEN)}@github.com/`)}.insteadOf https://github.com/`,
        ].join("; ") + ";"
      : "";

    const result = await executeInSandbox(`${authPrefix} ${buildBootstrapScript(this.repoDir, this.repo)}`.trim(), this.env, {
      sandboxId,
      timeout: 180000,
    });

    if (result.exitCode !== 0) {
      const excerpt = summarizeText(result.stderr || result.stdout || "unknown bootstrap error");
      throw new Error(`repo bootstrap failed (${this.repoDir}): ${excerpt}`);
    }

    if (verbosity === "verbose" && onProgress) {
      await onProgress(`Bootstrap ready for /workspace/${this.repoDir}`);
    }
  }

  private async callLLM(): Promise<LLMResponse> {
    if (this.env.AI_GATEWAY_BASE_URL && this.env.AI_GATEWAY_TOKEN) {
      const baseUrl = this.env.AI_GATEWAY_BASE_URL.replace(/\/$/, "");
      const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({ model: this.env.LLM_MODEL ?? DEFAULT_MODEL, messages: this.messages, tools: TOOL_SCHEMAS }),
      });
      if (!response.ok) {
        throw new Error(`LLM error: ${response.status} ${await response.text()}`);
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: LLMToolCall[] } }> };
      const msg = data.choices?.[0]?.message;
      return {
        content: msg?.content ?? "",
        toolCalls: msg?.tool_calls ?? [],
      };
    }

    throw new Error("AI gateway is required");
  }

  private async executeToolWithRetry(call: ToolCall, sandboxId: string): Promise<ToolResult> {
    const errorPrefix = `${call.tool} failed`;
    const maxRetries = call.tool === "bash" ? 2 : 1;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        switch (call.tool) {
          case "read":
            return { output: await readTool(String(call.args.path ?? ""), this.env, { sandboxId, workspaceRoot: `/workspace/${this.repoDir}` }) };
          case "write":
            await writeTool(String(call.args.path ?? ""), String(call.args.content ?? ""), this.env, { sandboxId, workspaceRoot: `/workspace/${this.repoDir}` });
            return { output: `Wrote ${String(call.args.path ?? "")}` };
          case "edit":
            await editTool(
              String(call.args.path ?? ""),
              String(call.args.oldText ?? ""),
              String(call.args.newText ?? ""),
              this.env,
              { sandboxId, workspaceRoot: `/workspace/${this.repoDir}` },
            );
            return { output: `Edited ${String(call.args.path ?? "")}` };
          case "bash": {
            const workspaceRoot = `/workspace/${this.repoDir}`;
            const result = await executeInSandbox(String(call.args.command ?? ""), this.env, { sandboxId, workspaceRoot });
            return { output: result.stdout, error: result.stderr || undefined };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ioError = message.toLowerCase().includes("eio") || message.toLowerCase().includes("i/o");
        const deterministic = message.toLowerCase().includes("not allowed") || message.toLowerCase().includes("oldtext not found");
        const shouldRetry = attempt < maxRetries && (call.tool === "bash" ? isTransientError(message) : ioError) && !deterministic;
        if (!shouldRetry) {
          return { output: "", error: `${errorPrefix}: ${message}` };
        }
        await new Promise((resolve) => setTimeout(resolve, call.tool === "bash" ? 5000 : 300));
      }
    }

    return { output: "", error: `${errorPrefix}: exhausted retries` };
  }

  private applyBudget(usage: BudgetState): string | null {
    const maxIn = Number.parseInt(this.env.JOB_MAX_INPUT_TOKENS ?? "100000", 10);
    const maxOut = Number.parseInt(this.env.JOB_MAX_OUTPUT_TOKENS ?? "20000", 10);
    const warningThreshold = 0.9;

    if (!usage.warned && (usage.inputTokens >= maxIn * warningThreshold || usage.outputTokens >= maxOut * warningThreshold)) {
      usage.warned = true;
      return "⚠️ Token budget at 90%";
    }

    if (usage.inputTokens >= maxIn || usage.outputTokens >= maxOut) {
      usage.halted = true;
      return "⏸️ Token budget reached; pausing job.";
    }

    return null;
  }

  private async consumeDailyBudget(totalTokens: number, critical: boolean): Promise<boolean> {
    const date = new Date().toISOString().slice(0, 10);
    const dailyCeiling = Number.parseInt(this.env.DAILY_TOKEN_CEILING ?? "500000", 10);

    // Try to persist to DO for durable tracking
    if (this.env.AGENT_DO) {
      try {
        const do_ = this.env.AGENT_DO.get(this.env.AGENT_DO.idFromName("blob"));
        const res = await do_.fetch("http://do/daily-tokens", {
          method: "POST",
          body: JSON.stringify({ date, tokens: totalTokens }),
        });
        const { totalTokens: total } = await res.json() as { totalTokens: number };
        if (!critical && total >= dailyCeiling) {
          return false;
        }
        return true;
      } catch {
        // Fall back to local tracking
      }
    }

    // Fallback: in-memory tracking
    const current = dailyTokenUsageLocal.get(date) ?? 0;
    if (!critical && current >= dailyCeiling) {
      return false;
    }
    dailyTokenUsageLocal.set(date, current + totalTokens);
    return true;
  }


  private async persistLearnedMemory(userMessage: string, finalResponse: string, conversationKey: string, sandboxId: string): Promise<void> {
    await ensureSandboxSession(sandboxId, this.env);
    const record = {
      timestamp: new Date().toISOString(),
      conversationKey,
      summary: summarizeText(`${userMessage} => ${finalResponse}`, 280),
      tags: ["agent-run"],
      sourceRefs: [this.repo],
    };
    await appendLearnedRecord(this.env, record);
    const flushed = await flushLearnedRecordsToR2(this.env, conversationKey);
    if (flushed.count > 0) {
      await updateLearnedMemoryStatus(this.env, {
        lastFlushAt: new Date().toISOString(),
        lastFlushCount: flushed.count,
        lastRecordTimestamp: flushed.lastRecord?.timestamp,
        lastRecordSummary: flushed.lastRecord?.summary,
      });
      const upsert = await upsertSemanticMemory(this.env, {
        conversationKey,
        record,
        r2Key: flushed.key,
      }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      await updateVectorizeMemoryStatus(this.env, {
        lastUpsertAt: new Date().toISOString(),
        lastUpsertOk: upsert.ok,
        lastUpsertError: upsert.ok ? undefined : upsert.error,
      });
    }
  }

  private async finishRun(userMessage: string, response: string, conversationKey: string, sandboxId: string): Promise<string> {
    try {
      await this.persistLearnedMemory(userMessage, response, conversationKey, sandboxId);
    } catch (err) {
      logEvent(this.env, "memory_ops", "learned_memory_persist_failed", { error: String(err) });
    }
    return response;
  }

  async runSelfTest(opts: SelfTestOptions = {}): Promise<string> {
    const sandboxId = opts.sandboxId ?? "default";
    const verbosity = opts.verbosity ?? "minimal";
    const conversationKey = opts.conversationKey ?? this.repoDir;
    const stepLines: string[] = [];
    const uniqueToken = `selftest-${Date.now()}`;

    const recordStep = async (label: string, detail: string, ok = true): Promise<void> => {
      const icon = ok ? "✅" : "❌";
      const line = `${icon} ${label}: ${detail}`;
      stepLines.push(line);
      if (verbosity === "verbose" && opts.onProgress) {
        await opts.onProgress(line);
      }
    };

    try {
      await this.ensureRepoBootstrapped(sandboxId, opts.onProgress, verbosity);
      await recordStep("bootstrap", `repo ready at /workspace/${this.repoDir}`);

      await executeInSandbox(`mkdir -p /workspace/${this.repoDir}/.blob`, this.env, {
        sandboxId,
        workspaceRoot: `/workspace/${this.repoDir}`,
      });

      const readme = await readTool("README.md", this.env, {
        sandboxId,
        workspaceRoot: `/workspace/${this.repoDir}`,
      });
      await recordStep("read", `README.md (${readme.length} bytes)`);

      await writeTool(".blob/selftest.txt", `${uniqueToken} initial`, this.env, {
        sandboxId,
        workspaceRoot: `/workspace/${this.repoDir}`,
      });
      await editTool(".blob/selftest.txt", "initial", "edited", this.env, {
        sandboxId,
        workspaceRoot: `/workspace/${this.repoDir}`,
      });
      await recordStep("write/edit", "updated .blob/selftest.txt");

      const bashResult = await executeInSandbox("node -v", this.env, {
        sandboxId,
        workspaceRoot: `/workspace/${this.repoDir}`,
      });
      if (bashResult.exitCode !== 0) {
        throw new Error(`bash command failed: ${summarizeText(bashResult.stderr || bashResult.stdout || "unknown error", 120)}`);
      }
      await recordStep("bash", summarizeText(bashResult.stdout || "node -v ok", 120));

      const record = {
        timestamp: new Date().toISOString(),
        conversationKey,
        summary: `Selftest learned record ${uniqueToken}`,
        tags: ["selftest", "healthcheck"],
        sourceRefs: [this.repo],
      };
      await appendLearnedRecord(this.env, record);
      const flushed = await flushLearnedRecordsToR2(this.env, conversationKey);
      if (!flushed.key || flushed.count < 1) {
        throw new Error("learned memory flush wrote no records");
      }
      const flushedObj = await this.env.REPO_STORE.get(flushed.key);
      const flushedText = flushedObj ? await flushedObj.text() : "";
      if (!flushedText.includes(uniqueToken)) {
        throw new Error("R2 read-back missing selftest learned record");
      }
      await updateLearnedMemoryStatus(this.env, {
        lastFlushAt: new Date().toISOString(),
        lastFlushCount: flushed.count,
        lastRecordTimestamp: flushed.lastRecord?.timestamp,
        lastRecordSummary: flushed.lastRecord?.summary,
      });
      await recordStep("r2", `flushed ${flushed.count} record(s) to ${flushed.key}`);

      if (!this.env.PI_VECTORS) {
        await updateVectorizeMemoryStatus(this.env, {
          lastUpsertAt: new Date().toISOString(),
          lastUpsertOk: false,
          lastUpsertError: "PI_VECTORS binding missing",
          lastQueryAt: new Date().toISOString(),
          lastQueryCount: 0,
        });
        await recordStep("vectorize", "skipped (PI_VECTORS binding missing; configure Vectorize to enable semantic recall)");
      } else {
        const upsert = await upsertSemanticMemory(this.env, {
          conversationKey,
          record,
          r2Key: flushed.key,
        });
        await updateVectorizeMemoryStatus(this.env, {
          lastUpsertAt: new Date().toISOString(),
          lastUpsertOk: upsert.ok,
          lastUpsertError: upsert.ok ? undefined : upsert.error,
        });
        if (!upsert.ok || !upsert.id) {
          throw new Error(`Vectorize upsert failed: ${upsert.error ?? "unknown error"}`);
        }

        const matches = await querySemanticMemory(this.env, {
          conversationKey,
          query: uniqueToken,
          topK: 5,
        });
        await updateVectorizeMemoryStatus(this.env, {
          lastQueryAt: new Date().toISOString(),
          lastQueryCount: matches.length,
        });
        const matched = matches.some((entry) => entry.id === upsert.id || entry.r2Key === flushed.key);
        if (!matched) {
          throw new Error("Vectorize query did not return selftest record");
        }
        await recordStep("vectorize", `upsert+query verified (${matches.length} match(es))`);
      }

      return verbosity === "verbose"
        ? `Self-test passed for /workspace/${this.repoDir}\n${stepLines.join("\n")}`
        : `Self-test passed: bootstrap, tools, and R2 are healthy for /workspace/${this.repoDir}.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordStep("selftest", summarizeText(message, 180), false);
      return verbosity === "verbose"
        ? `Self-test failed for /workspace/${this.repoDir}\n${stepLines.join("\n")}`
        : `Self-test failed: ${summarizeText(message, 180)}`;
    }
  }

  async run(userMessage: string, opts: RunOptions = {}): Promise<string> {
    const sandboxId = opts.sandboxId ?? "default";
    const usage: BudgetState = { inputTokens: 0, outputTokens: 0, warned: false, halted: false };
    const maxCalls = Number.parseInt(this.env.HEARTBEAT_MODEL_CALL_LIMIT ?? "10", 10);
    const maxConsecutiveFailures = Number.parseInt(this.env.MAX_CONSECUTIVE_TOOL_FAILURES ?? "5", 10);

    // Inject prior conversation history so the agent has context
    if (opts.conversationHistory?.length) {
      for (const msg of opts.conversationHistory) {
        this.messages.push({ role: msg.role as PiMessage["role"], content: msg.content });
      }
    }

    this.messages.push({ role: "user", content: userMessage });

    let modelCalls = 0;
    let consecutiveFailures = 0;
    let bootstrapAttempted = false;

    const verbosity = opts.verbosity ?? "verbose";
    const conversationKey = opts.conversationKey ?? this.repoDir;

    const semanticMatches = await querySemanticMemory(this.env, {
      conversationKey,
      query: userMessage,
      topK: 5,
    }).catch(() => []);
    await updateVectorizeMemoryStatus(this.env, {
      lastQueryAt: new Date().toISOString(),
      lastQueryCount: semanticMatches.length,
    });
    const semanticContext = await buildSemanticMemoryContext(this.env, semanticMatches, 1200).catch(() => "");
    if (semanticContext) {
      this.messages.splice(1, 0, { role: "system", content: semanticContext });
    }

    while (modelCalls < maxCalls) {
      modelCalls += 1;
      if (opts.onProgress && verbosity === "verbose" && modelCalls % 2 === 0) {
        await opts.onProgress(`Progress update: ${modelCalls} model calls used.`);
      }

      const llmResponse = await this.callLLM();
      const responseText = llmResponse.content || "";
      usage.inputTokens += estimateTokens(JSON.stringify(this.messages));
      usage.outputTokens += estimateTokens(responseText);

      if (!(await this.consumeDailyBudget(estimateTokens(responseText), opts.critical ?? false))) {
        return this.finishRun(userMessage, "⏸️ Daily token ceiling reached; paused non-critical job.", conversationKey, sandboxId);
      }

      const budgetNotice = this.applyBudget(usage);
      if (budgetNotice) {
        this.messages.push({ role: "assistant", content: budgetNotice });
      }
      if (usage.halted) {
        return this.finishRun(userMessage, "Paused due to token budget limit.", conversationKey, sandboxId);
      }

      const structuredToolCall = llmResponse.toolCalls.length > 0 ? parseStructuredToolCall(llmResponse.toolCalls[0]) : null;
      const toolCall = structuredToolCall ?? parseToolCall(responseText);
      if (!toolCall) {
        this.messages.push({ role: "assistant", content: responseText });
        await appendWorkspaceState("context", JSON.stringify({ role: "assistant", content: responseText }), this.env, sandboxId);
        return this.finishRun(userMessage, responseText, conversationKey, sandboxId);
      }

      this.messages.push({ role: "assistant", content: responseText || `TOOL: ${toolCall.tool}` });

      if (!bootstrapAttempted) {
        bootstrapAttempted = true;
        try {
          await this.ensureRepoBootstrapped(sandboxId, opts.onProgress, verbosity);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const failure = `Bootstrap failed: ${message}`;
          if (opts.onProgress && verbosity === "verbose") {
            await opts.onProgress(`⚠️ ${failure}`);
          }
          return this.finishRun(userMessage, failure, conversationKey, sandboxId);
        }
      }

      const toolStart = Date.now();
      const result = await this.executeToolWithRetry(toolCall, sandboxId);
      const toolDurationMs = Date.now() - toolStart;
      logEvent(this.env, "tool_call", result.error ? "tool_failure" : "tool_success", {
        tool: toolCall.tool,
        durationMs: toolDurationMs,
        error: result.error ?? undefined,
      });
      if (opts.onToolLedger) {
        await opts.onToolLedger({
          tool: toolCall.tool,
          argsSummary: summarizeArgs(toolCall.args),
          ok: !result.error,
          durationMs: toolDurationMs,
          error: result.error ?? undefined,
        });
      }
      if (result.error) {
        consecutiveFailures += 1;
        this.messages.push({
          role: "user",
          content: `TOOL_FAILURE: ${toolCall.tool}\nARG: ${JSON.stringify(toolCall.args)}\nERROR: ${result.error}`,
        });
        if (consecutiveFailures >= maxConsecutiveFailures) {
          const pauseMsg = `Paused after ${consecutiveFailures} consecutive tool failures.`;
          if (opts.onProgress) {
            await opts.onProgress(`⚠️ ${pauseMsg}`);
          }
          return this.finishRun(userMessage, pauseMsg, conversationKey, sandboxId);
        }
      } else {
        consecutiveFailures = 0;
        this.messages.push({
          role: "user",
          content: `TOOL: ${toolCall.tool}\nARG: ${JSON.stringify(toolCall.args)}\nRESULT: ${result.output}`,
        });
      }
      await appendWorkspaceState("log", JSON.stringify({ tool: toolCall.tool, ok: !result.error }), this.env, sandboxId);
    }

    return this.finishRun(userMessage, "Stopped after heartbeat model call limit.", conversationKey, sandboxId);
  }
}

export const __piAgentTestUtils = {
  parseToolCall,
  parseStructuredToolCall,
  summarizeArgs,
  TOOL_SCHEMAS,
  isTransientError,
  buildBootstrapScript,
};
