import type { Env } from "../core/types";
import { DEFAULT_MODEL, WORKERS_AI_FALLBACK_MODEL } from "../core/models";
import { appendWorkspaceState, editTool, ensureSandboxSession, executeInSandbox, readTool, writeTool } from "../integrations/sandbox";
import { logEvent } from "../core/observability";
import { estimateTokens } from "../core/tokens";
import { classifyIntent } from "../core/intent-classifier";
import { withDOAuth } from "../core/do-auth";
import { expireUnusedTools } from "./tool-lifecycle";
import { buildRepoBootstrapScript, detectVerificationCommand, repoDirFromSlug } from "./repo-diagnosis";
import {
  appendLearnedRecord,
  buildSemanticMemoryContext,
  flushLearnedRecordsToR2,
  querySemanticMemory,
  updateLearnedMemoryStatus,
  updateVectorizeMemoryStatus,
  upsertSemanticMemory,
} from "../core/memory-system";

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
  secrets?: Record<string, string>;
  /** Skip git clone/repo bootstrap. Use for tasks that only need bash (e.g. curl for external data). Sandbox still runs. */
  skipRepoBootstrap?: boolean;
}

interface SelfTestOptions {
  sandboxId?: string;
  onProgress?: (message: string) => Promise<void> | void;
  verbosity?: "minimal" | "verbose";
  conversationKey?: string;
  secrets?: Record<string, string>;
}


interface BudgetState {
  inputTokens: number;
  outputTokens: number;
  warned: boolean;
  halted: boolean;
}

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("timeout") || lower.includes("econn") || lower.includes("temporar") || lower.includes("503");
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
  } catch (_err) {
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

const TOOL_AVOIDANCE_CLAIMS = /\b(i\s+(?:do\s*not|don't|cannot|can't)\s+(?:access|get|retrieve|provide)|no\s+access|unable\s+to\s+(?:access|get|retrieve)|don't\s+have\s+access|real\s*[- ]?time\s+data)\b/i;

function containsToolAvoidanceClaim(message: string): boolean {
  return TOOL_AVOIDANCE_CLAIMS.test(message);
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function chunkString(input: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(input.slice(i, i + chunkSize));
  }
  return chunks;
}

function buildCurrentDateTimeMessage(): PiMessage {
  const nowIso = new Date().toISOString();
  return {
    role: "system",
    content: `Current date/time (UTC): ${nowIso}. Treat this as the authoritative current timestamp for time-sensitive requests.`,
  };
}

export class PiAgent {
  private messages: PiMessage[];
  private repoDir: string;
  private activeSecrets: Record<string, string> = {};
  private skipRepoBootstrap = false;

  constructor(
    private env: Env,
    private repo: string,
  ) {
    // repo may be "owner/name" but the sandbox clones into /workspace/<name>
    this.repoDir = repoDirFromSlug(repo);
    this.messages = [{ role: "system", content: this.buildSystemPrompt() }];
  }

  private buildSystemPrompt(): string {
    const verifyCmd = this.env.VERIFY_COMMAND ?? "";
    const verifyBlock = verifyCmd
      ? `\n\nAfter making code changes, ALWAYS verify your work by running: ${verifyCmd}
If the verification fails, read the error output carefully, fix the issues, and re-run verification. Repeat until all errors are resolved or you have exhausted your reasonable attempts. Never consider a task complete if verification is failing.`
      : `\n\nAfter making code changes, verify your work by running the project's test and type-check commands (e.g. npm test, tsc --noEmit, or whatever the project uses). If errors appear, read the output carefully, fix the issues, and re-run verification. Repeat until all errors are resolved. Never consider a task complete if verification is failing.`;

    const toolFramework = `

## Self-Tool-Creation Framework

Your workspace includes a tool framework at /workspace/${this.repoDir}/.blob/:

- /workspace/${this.repoDir}/.blob/tools/manifest.json — registry of all self-created tools
- /workspace/${this.repoDir}/.blob/tools/ — directory of tool scripts you build
- /workspace/${this.repoDir}/.blob/config/services.json — API endpoints and auth details for external services
- /workspace/${this.repoDir}/.blob/memory/context.md — rolling context about the user (preferences, patterns, recurring tasks)
- /workspace/${this.repoDir}/.blob/memory/journal.md — log of what you have done
- /workspace/${this.repoDir}/.blob/scratch/ — temporary workspace for testing new tools before promoting them

When you need a capability, act immediately — do not narrate your plan:

For live information requests (weather, prices, public web lookups, simple API fetches, status checks): use bash with curl directly and return the result. Do not check tool registries or service configs first — just execute.

For all other tasks:
1. bash first: attempt the task directly (curl, wget, a one-liner, whatever fits). If it succeeds, you are done.
2. If direct bash fails: read .blob/tools/manifest.json to check if you already built a tool for this task
3. If a matching tool exists: read the tool file, bash to execute it
4. If no matching tool exists: read .blob/config/services.json for API details, write a new script to .blob/scratch/, bash to test it, then write the working version to .blob/tools/ and edit .blob/tools/manifest.json to register it

Before promoting a new tool, ALWAYS test it in .blob/scratch/ first.
Tools are validated for secret patterns before promotion to .blob/tools/.
Unused tools are automatically expired based on TOOL_EXPIRY_DAYS.
After each task, edit .blob/memory/journal.md with a brief log of what you did.
When you learn something about the user, edit .blob/memory/context.md.

If a tool script fails (non-zero exit or API error), read the error, edit the script to fix it, and re-run. After 3 failures, log the error to .blob/memory/journal.md and report that you are stuck.

Reuse existing tools before rebuilding. Your .blob/tools/ directory is your growing skillset.

## Secrets and Authentication

Stored API tokens are injected as sandbox environment variables. Use them directly with $TOKEN_NAME and never write secrets to files.

When a tool fails due to missing authentication (401, 403, "unauthorized", missing token), do NOT keep retrying. Instead:
1. Tell the user which service needs a token and what kind of token is needed
2. Ask them to paste the token directly in this chat
3. Once they provide it, confirm you received it and it will be stored securely

Never echo back or display a secret/token the user provides. Just confirm receipt.`;

    return `You are a versatile assistant with access to a workspace at /workspace/${this.repoDir}.

You have 4 tools — read, write, edit, bash — which together give you full capability to accomplish any task. The bash tool lets you run arbitrary commands: install packages, fetch URLs, run scripts, use git, compile code, query APIs, and anything else a Linux shell can do. Never say you cannot do something — figure out how to accomplish it with your tools.${toolFramework}${verifyBlock}

Use structured tool calls via the provided tool schema whenever you need to execute an action.
Stop when done and provide a concise summary.`;
  }

  private async ensureRepoBootstrapped(
    sandboxId: string,
    onProgress?: RunOptions["onProgress"],
    verbosity: RunOptions["verbosity"] = "minimal",
  ): Promise<void> {
    await ensureSandboxSession(sandboxId, this.env);

    const cacheKey = `repo-cache/${this.repoDir}.tar.gz`;
    let restoredFromCache = false;

    if (this.env.REPO_STORE) {
      try {
        const cacheObject = await this.env.REPO_STORE.get(cacheKey);
        if (cacheObject) {
          await this.restoreRepoFromCache(sandboxId, cacheObject);
          restoredFromCache = true;
        }
      } catch (err) {
        logEvent(this.env, "tool_call", "repo_cache_restore_failed", { repoDir: this.repoDir, error: String(err) });
        await this.clearWorkspaceRepo(sandboxId);
      }
    }

    let result = await executeInSandbox(buildRepoBootstrapScript(this.repoDir, this.repo), this.env, {
      sandboxId,
      timeout: 180000,
      envVars: this.env.GITHUB_TOKEN
        ? {
            GITHUB_TOKEN: this.env.GITHUB_TOKEN,
            GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
            GIT_TERMINAL_PROMPT: "0",
          }
        : undefined,
    });

    if (result.exitCode !== 0 && restoredFromCache) {
      logEvent(this.env, "tool_call", "repo_cache_restore_bootstrap_fallback", { repoDir: this.repoDir, stderr: summarizeText(result.stderr, 400) });
      await this.clearWorkspaceRepo(sandboxId);
      result = await executeInSandbox(buildRepoBootstrapScript(this.repoDir, this.repo), this.env, {
        sandboxId,
        timeout: 180000,
        envVars: this.env.GITHUB_TOKEN
          ? {
              GITHUB_TOKEN: this.env.GITHUB_TOKEN,
              GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
              GIT_TERMINAL_PROMPT: "0",
            }
          : undefined,
      });
    }

    if (result.exitCode !== 0) {
      const excerpt = summarizeText(result.stderr || result.stdout || "unknown bootstrap error");
      throw new Error(`repo bootstrap failed (${this.repoDir}): ${excerpt}`);
    }

    if (this.env.REPO_STORE) {
      try {
        await this.uploadRepoCache(sandboxId, cacheKey);
      } catch (err) {
        logEvent(this.env, "tool_call", "repo_cache_upload_failed", { repoDir: this.repoDir, error: String(err) });
      }
    }

    await this.ensureToolFramework(sandboxId);

    if (verbosity === "verbose" && onProgress) {
      await onProgress(`Bootstrap ready for /workspace/${this.repoDir}`);
    }
  }

  private async clearWorkspaceRepo(sandboxId: string): Promise<void> {
    await executeInSandbox(`rm -rf ${shellQuote(`/workspace/${this.repoDir}`)}`, this.env, { sandboxId, timeout: 60000 });
  }

  private async restoreRepoFromCache(sandboxId: string, cacheObject: R2ObjectBody): Promise<void> {
    const tarPath = `/tmp/${this.repoDir}.tar.gz`;
    const base64Path = `${tarPath}.b64`;
    const bytes = new Uint8Array(await cacheObject.arrayBuffer());
    const base64 = encodeBase64(bytes);
    const chunks = chunkString(base64, 700_000);

    await executeInSandbox(`rm -f ${shellQuote(base64Path)} ${shellQuote(tarPath)} && mkdir -p /workspace`, this.env, { sandboxId, timeout: 60000 });

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      const chunkPath = `${base64Path}.part.${index.toString().padStart(4, "0")}`;
      await this.env.SANDBOX.writeFile(chunkPath, chunk);
    }

    const restoreResult = await executeInSandbox(
      `set -eu
cat ${shellQuote(`${base64Path}.part.`)}* > ${shellQuote(base64Path)}
base64 -d ${shellQuote(base64Path)} > ${shellQuote(tarPath)}
tar -xzf ${shellQuote(tarPath)} -C /
rm -f ${shellQuote(base64Path)} ${shellQuote(tarPath)} ${shellQuote(`${base64Path}.part.`)}*`,
      this.env,
      { sandboxId, timeout: 180000 },
    );

    if (restoreResult.exitCode !== 0) {
      throw new Error(`cache restore command failed: ${restoreResult.stderr || restoreResult.stdout || "unknown"}`);
    }
  }

  private async uploadRepoCache(sandboxId: string, cacheKey: string): Promise<void> {
    const partsPrefix = `/tmp/${this.repoDir}.repo-cache.part.`;
    const chunkCountResult = await executeInSandbox(
      `set -eu
rm -f ${shellQuote(partsPrefix)}*
tar -czf - ${shellQuote(`/workspace/${this.repoDir}`)} | base64 -w0 | split -b 700k -d -a 4 - ${shellQuote(partsPrefix)}
ls ${shellQuote(partsPrefix)}* | wc -l`,
      this.env,
      { sandboxId, timeout: 180000 },
    );

    if (chunkCountResult.exitCode !== 0) {
      throw new Error(`cache archive failed: ${chunkCountResult.stderr || chunkCountResult.stdout || "unknown"}`);
    }

    const chunkCount = Number.parseInt(chunkCountResult.stdout.trim(), 10);
    if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
      throw new Error(`invalid cache chunk count: ${chunkCountResult.stdout}`);
    }

    const decodedChunks: Uint8Array[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunkPath = `${partsPrefix}${index.toString().padStart(4, "0")}`;
      const encodedChunk = await this.env.SANDBOX.readFile(chunkPath);
      decodedChunks.push(decodeBase64(encodedChunk.trim()));
    }

    const archiveBytes = concatBytes(decodedChunks);
    await this.env.REPO_STORE.put(cacheKey, archiveBytes, {
      httpMetadata: { contentType: "application/gzip" },
    });

    await executeInSandbox(`rm -f ${shellQuote(partsPrefix)}*`, this.env, { sandboxId, timeout: 30000 });
  }

  private async ensureToolFramework(sandboxId: string): Promise<void> {
    const blobDir = `/workspace/${this.repoDir}/.blob`;
    const initScript = `set -eu
mkdir -p ${blobDir}/tools ${blobDir}/config ${blobDir}/memory ${blobDir}/scratch

# Seed manifest.json if missing
if [ ! -f ${blobDir}/tools/manifest.json ]; then
  cat > ${blobDir}/tools/manifest.json << 'SEED'
{"tools":[]}
SEED
fi

# Seed services.json if missing
if [ ! -f ${blobDir}/config/services.json ]; then
  cat > ${blobDir}/config/services.json << 'SEED'
{"services":{}}
SEED
fi

# Seed context.md if missing
if [ ! -f ${blobDir}/memory/context.md ]; then
  cat > ${blobDir}/memory/context.md << 'SEED'
# User Context
SEED
fi

# Seed journal.md if missing
if [ ! -f ${blobDir}/memory/journal.md ]; then
  cat > ${blobDir}/memory/journal.md << 'SEED'
# Journal
SEED
fi
`;
    await executeInSandbox(initScript, this.env, { sandboxId });

    const days = Number.parseInt(this.env.TOOL_EXPIRY_DAYS ?? "30", 10);
    try {
      await expireUnusedTools(`${blobDir}/tools/manifest.json`, this.env, Number.isFinite(days) ? days : 30);
    } catch (err) {
      logEvent(this.env, "tool_call", "tool_expiry_failed", { error: String(err) });
    }

  }

  private async callLLM(): Promise<LLMResponse> {
    const messagesWithCurrentDateTime = [...this.messages, buildCurrentDateTimeMessage()];
    if (this.env.AI_GATEWAY_BASE_URL && this.env.AI_GATEWAY_TOKEN) {
      const baseUrl = this.env.AI_GATEWAY_BASE_URL.replace(/\/$/, "");
      const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
      const retryableStatuses = new Set([429, 500, 502, 503, 504]);
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
            },
            body: JSON.stringify({
              model: this.env.LLM_MODEL ?? DEFAULT_MODEL,
              messages: messagesWithCurrentDateTime,
              tools: TOOL_SCHEMAS,
              max_tokens: 4096,
            }),
          });

          if (!response.ok) {
            const body = await response.text();
            const error = new Error(`LLM error: ${response.status} ${body}`);
            const shouldRetry = retryableStatuses.has(response.status) && attempt < maxAttempts;
            if (!shouldRetry) {
              throw error;
            }
            const delayMs = 1000 * (2 ** (attempt - 1));
            logEvent(this.env, "tool_call", "llm_retry", { attempt, delayMs, status: response.status, error: error.message });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          const data = await response.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: LLMToolCall[] } }> };
          const msg = data.choices?.[0]?.message;
          return {
            content: msg?.content ?? "",
            toolCalls: msg?.tool_calls ?? [],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isNetworkError = /fetch|network|timeout|socket|econn|etimedout/i.test(message);
          if (!isNetworkError || attempt >= maxAttempts) {
            throw err;
          }
          const delayMs = 1000 * (2 ** (attempt - 1));
          logEvent(this.env, "tool_call", "llm_retry", { attempt, delayMs, error: message });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      throw new Error("LLM retries exhausted");
    }

    // Fallback to Workers AI when AI Gateway is not configured
    const ai = (this.env as any).AI as { run: (model: string, inputs: { messages: PiMessage[]; max_tokens: number }) => Promise<{ response?: string }> } | undefined;
    if (!ai) {
      throw new Error("Neither AI Gateway nor Workers AI available");
    }
    const result = await ai.run(WORKERS_AI_FALLBACK_MODEL, {
      messages: messagesWithCurrentDateTime,
      max_tokens: 4096,
    });
    return {
      content: result.response ?? "",
      toolCalls: [],
    };
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
            // When skipRepoBootstrap is set, don't force a cd to the workspace dir
            // (it doesn't exist). Run the command in the sandbox root instead.
            const workspaceRoot = this.skipRepoBootstrap ? undefined : `/workspace/${this.repoDir}`;
            const result = await executeInSandbox(String(call.args.command ?? ""), this.env, { sandboxId, workspaceRoot, envVars: this.activeSecrets });
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

    if (!this.env.AGENT_DO) {
      logEvent(this.env, "cost", "daily_budget_do_missing");
      return false;
    }

    try {
      const do_ = this.env.AGENT_DO.get(this.env.AGENT_DO.idFromName("blob"));
      const res = await do_.fetch("http://do/daily-tokens", withDOAuth(this.env, {
        method: "POST",
        body: JSON.stringify({ date, tokens: totalTokens }),
      }));
      if (!res.ok) {
        logEvent(this.env, "cost", "daily_budget_do_rejected", { status: res.status });
        return false;
      }

      const { totalTokens: total } = await res.json() as { totalTokens: number };
      if (!critical && total >= dailyCeiling) {
        return false;
      }
      return true;
    } catch (err) {
      logEvent(this.env, "cost", "daily_budget_do_unreachable", { error: String(err) });
      return false;
    }
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
    this.activeSecrets = opts.secrets ?? {};
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

      logEvent(this.env, "tool_call", "selftest_passed", {
        repo: this.repo,
        sandboxId,
        conversationKey,
      });

      return verbosity === "verbose"
        ? `Self-test passed for /workspace/${this.repoDir}\n${stepLines.join("\n")}`
        : `Self-test passed: bootstrap, tools, and R2 are healthy for /workspace/${this.repoDir}.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent(this.env, "tool_call", "selftest_failed", {
        repo: this.repo,
        sandboxId,
        conversationKey,
        error: message,
      });
      await recordStep("selftest", summarizeText(message, 180), false);
      return verbosity === "verbose"
        ? `Self-test failed for /workspace/${this.repoDir}\n${stepLines.join("\n")}`
        : `Self-test failed: ${summarizeText(message, 180)}`;
    }
  }

  private async runVerification(
    sandboxId: string,
    bootstrapAttempted: boolean,
    currentAttempt: number,
    maxAttempts: number,
    opts: RunOptions,
  ): Promise<{ passed: boolean; skipped: boolean; output: string }> {
    const verifyCommand = await detectVerificationCommand(this.env, this.repo, sandboxId);
    if (!verifyCommand || currentAttempt >= maxAttempts) {
      return { passed: true, skipped: !verifyCommand, output: "" };
    }

    if (!bootstrapAttempted) {
      return { passed: true, skipped: true, output: "" };
    }

    try {
      const result = await executeInSandbox(verifyCommand, this.env, {
        sandboxId,
        workspaceRoot: `/workspace/${this.repoDir}`,
        timeout: 120000,
      });

      if (result.exitCode === 0) {
        logEvent(this.env, "tool_call", "verify_passed", { attempt: currentAttempt + 1 });
        if (opts.onProgress && (opts.verbosity ?? "verbose") === "verbose") {
          await opts.onProgress("✅ Verification passed");
        }
        return { passed: true, skipped: false, output: result.stdout };
      }

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return { passed: false, skipped: false, output: summarizeText(output, 2000) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { passed: false, skipped: false, output: `Verification error: ${message}` };
    }
  }

  private async shouldForceExternalToolForMessage(userMessage: string): Promise<boolean> {
    try {
      const result = await classifyIntent(userMessage, this.env);
      return result.intent === "chat" && result.needsSandbox === true && result.externalDataOnly === true;
    } catch (_err) {
      return false;
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
    let verifyAttempts = 0;
    let toolCallsExecuted = 0;
    let externalDataGuardAttempts = 0;
    let shouldForceExternalTool: boolean | null = null;
    const maxVerifyAttempts = Number.parseInt(this.env.VERIFY_MAX_ATTEMPTS ?? "3", 10);

    const verbosity = opts.verbosity ?? "verbose";
    const conversationKey = opts.conversationKey ?? this.repoDir;
    this.activeSecrets = opts.secrets ?? {};

    const semanticMatches = await querySemanticMemory(this.env, {
      conversationKey,
      query: userMessage,
      topK: 5,
    }).catch((err: unknown) => {
      logEvent(this.env, "memory_ops", "semantic_query_failed", { error: String(err) });
      return [];
    });
    await updateVectorizeMemoryStatus(this.env, {
      lastQueryAt: new Date().toISOString(),
      lastQueryCount: semanticMatches.length,
    });
    const semanticContext = await buildSemanticMemoryContext(this.env, semanticMatches, 1200).catch((err: unknown) => {
      logEvent(this.env, "memory_ops", "semantic_context_build_failed", { error: String(err) });
      return "";
    });
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
      const toolCall = structuredToolCall;
      if (!toolCall) {
        if (shouldForceExternalTool === null) {
          shouldForceExternalTool = await this.shouldForceExternalToolForMessage(userMessage);
        }
        const claimedNoAccess = containsToolAvoidanceClaim(responseText);
        const shouldForceToolAttempt =
          toolCallsExecuted === 0 && externalDataGuardAttempts < 1 && (shouldForceExternalTool || claimedNoAccess);
        if (shouldForceToolAttempt) {
          externalDataGuardAttempts += 1;
          this.messages.push({ role: "assistant", content: responseText });
          this.messages.push({
            role: "user",
            content: "Before finalizing, use an available tool (typically bash with curl) to fetch real external data for this request, then answer using the result. Do not claim lack of access without attempting a tool call.",
          });
          if (opts.onProgress && verbosity === "verbose") {
            await opts.onProgress("🔎 External/fresh-data request detected: prompting model to call tools before final answer.");
          }
          continue;
        }

        // No tool call — the model thinks it's done. Run verification if configured.
        const verifyResult = await this.runVerification(sandboxId, bootstrapAttempted, verifyAttempts, maxVerifyAttempts, opts);
        if (verifyResult.passed || verifyResult.skipped) {
          this.messages.push({ role: "assistant", content: responseText });
          await appendWorkspaceState("context", JSON.stringify({ role: "assistant", content: responseText }), this.env, sandboxId);
          return this.finishRun(userMessage, responseText, conversationKey, sandboxId);
        }
        // Verification failed — feed errors back to model and continue loop
        verifyAttempts += 1;
        this.messages.push({ role: "assistant", content: responseText });
        this.messages.push({
          role: "user",
          content: `VERIFICATION FAILED (attempt ${verifyAttempts}/${maxVerifyAttempts}):\n${verifyResult.output}\n\nPlease fix the errors above and try again.`,
        });
        logEvent(this.env, "tool_call", "verify_failed", {
          attempt: verifyAttempts,
          maxAttempts: maxVerifyAttempts,
          output: summarizeText(verifyResult.output, 300),
        });
        if (opts.onProgress && verbosity === "verbose") {
          await opts.onProgress(`🔄 Verification failed (attempt ${verifyAttempts}/${maxVerifyAttempts}), auto-fixing…`);
        }
        continue;
      }

      this.messages.push({ role: "assistant", content: responseText || `TOOL: ${toolCall.tool}` });

      if (!bootstrapAttempted) {
        bootstrapAttempted = true;
        if (opts.skipRepoBootstrap) {
          // Bare sandbox — just ensure the session is alive, skip git clone.
          this.skipRepoBootstrap = true;
          await ensureSandboxSession(sandboxId, this.env);
        } else {
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
        toolCallsExecuted += 1;
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
  parseStructuredToolCall,
  summarizeArgs,
  TOOL_SCHEMAS,
  isTransientError,
  buildBootstrapScript: buildRepoBootstrapScript,
  containsToolAvoidanceClaim,
};
