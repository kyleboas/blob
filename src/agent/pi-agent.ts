import type { Env } from "../core/types";
import { DEFAULT_MODEL } from "../core/models";
import { appendWorkspaceState, editTool, executeInSandbox, readTool, writeTool } from "../integrations/sandbox";

interface PiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ToolCall {
  tool: "read" | "write" | "edit" | "bash";
  args: Record<string, unknown>;
}

interface ToolResult {
  output: string;
  error?: string;
}

interface RunOptions {
  sandboxId?: string;
  critical?: boolean;
  onProgress?: (message: string) => Promise<void> | void;
}

interface BudgetState {
  inputTokens: number;
  outputTokens: number;
  warned: boolean;
  halted: boolean;
}

const dailyTokenUsage = new Map<string, number>();

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("timeout") || lower.includes("econn") || lower.includes("temporar") || lower.includes("503");
}

function parseToolCall(response: string): ToolCall | null {
  const toolMatch = response.match(/TOOL:\s*(\w+)/);
  const argMatch = response.match(/ARG:\s*(.+)/s);
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
    return `You are a coding assistant in /workspace/${this.repoDir}.
Use only these tools: read, write, edit, bash.
When calling tools, output exactly:\nTOOL: <name>\nARG: <json>
Stop when done and provide a concise summary.`;
  }

  private async callLLM(): Promise<string> {
    if (this.env.AI_GATEWAY_BASE_URL && this.env.AI_GATEWAY_TOKEN) {
      const baseUrl = this.env.AI_GATEWAY_BASE_URL.replace(/\/$/, "");
      const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages: this.messages }),
      });
      if (!response.ok) {
        throw new Error(`LLM error: ${response.status} ${await response.text()}`);
      }
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
      };
      const msg = data.choices?.[0]?.message;
      if (msg?.tool_calls?.length) {
        const call = msg.tool_calls[0].function;
        return `TOOL: ${call.name}\nARG: ${call.arguments}`;
      }
      return msg?.content ?? "";
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
            return { output: await readTool(String(call.args.path ?? ""), this.env, sandboxId) };
          case "write":
            await writeTool(String(call.args.path ?? ""), String(call.args.content ?? ""), this.env, sandboxId);
            return { output: `Wrote ${String(call.args.path ?? "")}` };
          case "edit":
            await editTool(
              String(call.args.path ?? ""),
              String(call.args.oldText ?? ""),
              String(call.args.newText ?? ""),
              this.env,
              sandboxId,
            );
            return { output: `Edited ${String(call.args.path ?? "")}` };
          case "bash": {
            const result = await executeInSandbox(`cd /workspace/${this.repoDir} && ${String(call.args.command ?? "")}`, this.env, { sandboxId });
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

  private consumeDailyBudget(totalTokens: number, critical: boolean): boolean {
    const date = new Date().toISOString().slice(0, 10);
    const current = dailyTokenUsage.get(date) ?? 0;
    const dailyCeiling = Number.parseInt(this.env.DAILY_TOKEN_CEILING ?? "500000", 10);
    if (!critical && current >= dailyCeiling) {
      return false;
    }
    dailyTokenUsage.set(date, current + totalTokens);
    return true;
  }

  async run(userMessage: string, opts: RunOptions = {}): Promise<string> {
    const sandboxId = opts.sandboxId ?? "default";
    const usage: BudgetState = { inputTokens: 0, outputTokens: 0, warned: false, halted: false };
    const maxCalls = Number.parseInt(this.env.HEARTBEAT_MODEL_CALL_LIMIT ?? "10", 10);
    const maxConsecutiveFailures = Number.parseInt(this.env.MAX_CONSECUTIVE_TOOL_FAILURES ?? "5", 10);

    this.messages.push({ role: "user", content: userMessage });

    let modelCalls = 0;
    let consecutiveFailures = 0;

    while (modelCalls < maxCalls) {
      modelCalls += 1;
      if (opts.onProgress && modelCalls % 2 === 0) {
        await opts.onProgress(`Progress update: ${modelCalls} model calls used.`);
      }

      const response = await this.callLLM();
      usage.inputTokens += estimateTokens(JSON.stringify(this.messages));
      usage.outputTokens += estimateTokens(response);

      if (!this.consumeDailyBudget(estimateTokens(response), opts.critical ?? false)) {
        return "⏸️ Daily token ceiling reached; paused non-critical job.";
      }

      const budgetNotice = this.applyBudget(usage);
      if (budgetNotice) {
        this.messages.push({ role: "assistant", content: budgetNotice });
      }
      if (usage.halted) {
        return "Paused due to token budget limit.";
      }

      const toolCall = parseToolCall(response);
      if (!toolCall) {
        this.messages.push({ role: "assistant", content: response });
        await appendWorkspaceState("context", JSON.stringify({ role: "assistant", content: response }), this.env, sandboxId);
        return response;
      }

      this.messages.push({ role: "assistant", content: response });
      const result = await this.executeToolWithRetry(toolCall, sandboxId);
      if (result.error) {
        consecutiveFailures += 1;
        this.messages.push({
          role: "user",
          content: `TOOL_FAILURE: ${toolCall.tool}\nARG: ${JSON.stringify(toolCall.args)}\nERROR: ${result.error}`,
        });
        if (consecutiveFailures >= maxConsecutiveFailures) {
          return `Paused after ${consecutiveFailures} consecutive tool failures.`;
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

    return "Stopped after heartbeat model call limit.";
  }
}

export const __piAgentTestUtils = {
  parseToolCall,
  isTransientError,
};
