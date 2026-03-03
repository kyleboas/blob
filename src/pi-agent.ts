// pi-agent.ts - Minimal Pi-style agent with 4 tools + extension system
// Inspired by https://github.com/badlogic/pi-mono/ and https://lucumr.pocoo.org/2026/1/31/pi/

import type { Env } from "./types";

interface ToolResult {
  output: string;
  error?: string;
}

interface PiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Parameter schema for a single tool argument
interface ToolParam {
  type: string;
  description: string;
}

// A registered tool: schema + prompt hints + execution handler
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParam>;
  required?: string[];
  /** One-liner injected into the "Available tools" section of the system prompt */
  promptSnippet?: string;
  /** Tool-specific guidelines appended to the system prompt */
  promptGuidelines?: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const EXTENSIONS_DIR = "/workspace/.blob/extensions";

export class PiAgent {
  private messages: PiMessage[] = [];
  private loadedExtensions: Set<string> = new Set();
  private toolRegistry = new Map<string, ToolDefinition>();

  constructor(
    private env: Env,
    private repo: string
  ) {
    this.registerBuiltinTools();
    this.messages.push({ role: "system", content: this.buildSystemPrompt() });
  }

  /** Register a tool and refresh the system prompt so the LLM sees it immediately */
  registerTool(def: ToolDefinition): void {
    this.toolRegistry.set(def.name, def);
    const sysIdx = this.messages.findIndex(m => m.role === "system");
    if (sysIdx !== -1) {
      this.messages[sysIdx] = { role: "system", content: this.buildSystemPrompt() };
    }
  }

  /** Build system prompt dynamically from the tool registry (like Pi's buildSystemPrompt) */
  private buildSystemPrompt(): string {
    const toolLines = Array.from(this.toolRegistry.values())
      .map(t => `- ${t.promptSnippet ?? `${t.name}: ${t.description}`}`)
      .join("\n");

    const guidelines = Array.from(this.toolRegistry.values())
      .filter(t => t.promptGuidelines)
      .map(t => t.promptGuidelines!)
      .join("\n\n");

    return `You are a helpful coding assistant working in an isolated sandbox container.
All files live under /workspace/${this.repo}/. Always use relative paths with the file tools (e.g. src/index.ts, not /workspace/${this.repo}/src/index.ts).
Shell commands run inside the container with /workspace/${this.repo} as the working directory.

Available tools:
${toolLines}

When you need to use a tool, output:
TOOL: tool_name
ARG: argument (JSON)

Then wait for the result. Continue until the task is complete.
Be concise. Don't ask for confirmation. Just do it.${guidelines ? `\n\n${guidelines}` : ""}`;
  }

  /** Build the OpenAI-compatible tools array passed to the LLM API */
  private buildToolsParam(): Array<{ type: "function"; function: { name: string; description: string; parameters: object } }> {
    return Array.from(this.toolRegistry.values()).map(t => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
          ),
          required: t.required ?? Object.keys(t.parameters),
        },
      },
    }));
  }

  private registerBuiltinTools(): void {
    this.toolRegistry.set("read", {
      name: "read",
      description: "Read file contents",
      parameters: {
        path: { type: "string", description: "File path relative to workspace" },
      },
      promptSnippet: "read(path) - Read file contents",
      handler: async (args) => this.toolRead(args.path as string),
    });

    this.toolRegistry.set("write", {
      name: "write",
      description: "Create or overwrite a file",
      parameters: {
        path: { type: "string", description: "File path relative to workspace" },
        content: { type: "string", description: "File content to write" },
      },
      promptSnippet: "write(path, content) - Write file (overwrites)",
      handler: async (args) => this.toolWrite(args.path as string, args.content as string),
    });

    this.toolRegistry.set("edit", {
      name: "edit",
      description: "Replace text in a file",
      parameters: {
        path: { type: "string", description: "File path relative to workspace" },
        oldText: { type: "string", description: "Exact text to replace" },
        newText: { type: "string", description: "Replacement text" },
      },
      promptSnippet: "edit(path, oldText, newText) - Replace text in file",
      handler: async (args) => this.toolEdit(args.path as string, args.oldText as string, args.newText as string),
    });

    this.toolRegistry.set("bash", {
      name: "bash",
      description: "Execute a shell command in the workspace",
      parameters: {
        command: { type: "string", description: "Shell command to execute" },
      },
      promptSnippet: "bash(command) - Execute shell command",
      promptGuidelines: "For real-time data (weather, time, etc.), use bash to fetch it (e.g., curl wttr.in for weather). Do not say you lack real-time access.",
      handler: async (args) => this.toolBash(args.command as string),
    });

    this.toolRegistry.set("memory", {
      name: "memory",
      description: "Persistent memory with semantic search",
      parameters: {
        cmd: { type: "string", description: "Command: set, get, list, delete, search" },
        key: { type: "string", description: "Key or search query" },
        value: { type: "string", description: "Value to store (for set)" },
      },
      required: ["cmd", "key"],
      promptSnippet: "memory(cmd, key, value?) - Memory ops: set/get/list/delete/search (search uses key as query)",
      handler: async (args) => this.toolMemory(args.cmd as string, args.key as string, args.value as string | undefined),
    });

    this.toolRegistry.set("extension", {
      name: "extension",
      description: "Write a bash script to add new capabilities, then load it",
      parameters: {
        name: { type: "string", description: "Extension name (no .sh suffix)" },
        content: { type: "string", description: "Bash script content" },
      },
      promptSnippet: "extension(name, content) - Create and load a bash extension to add new capabilities",
      handler: async (args) => this.toolExtension(args.name as string, args.content as string),
    });

    this.toolRegistry.set("load", {
      name: "load",
      description: "Load an existing bash extension by name",
      parameters: {
        name: { type: "string", description: "Extension name to load (no .sh suffix)" },
      },
      promptSnippet: "load(name) - Load an existing extension",
      handler: async (args) => this.toolLoad(args.name as string),
    });
  }

  async run(userMessage: string): Promise<string> {
    // Auto-load existing extensions
    await this.autoLoadExtensions();

    this.messages.push({ role: "user", content: userMessage });

    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;

      // Single LLM call - passes both system prompt snippets and structured tools param
      const response = await this.callLLM();

      // Check if response contains tool calls
      const toolCall = this.parseToolCall(response);

      if (!toolCall) {
        // No tool call - return final response
        this.messages.push({ role: "assistant", content: response });
        return response;
      }

      // Execute tool via registry
      const result = await this.executeTool(toolCall);

      // Add tool result to context
      this.messages.push({
        role: "assistant",
        content: `TOOL: ${toolCall.tool}\nARG: ${JSON.stringify(toolCall.args)}\n\nRESULT: ${result.output}${result.error ? `\nERROR: ${result.error}` : ""}`,
      });
    }

    return "Reached maximum iterations. Task may be incomplete.";
  }

  private async autoLoadExtensions(): Promise<void> {
    try {
      const result = await this.env.SANDBOX.exec(`ls -1 ${EXTENSIONS_DIR}/*.sh 2>/dev/null || echo "No extensions"`);
      const files = result.stdout.split("\n").filter(f => f.endsWith(".sh"));

      for (const file of files) {
        const name = file.replace(".sh", "").split("/").pop();
        if (name && !this.loadedExtensions.has(name)) {
          await this.toolLoad(name);
        }
      }
    } catch {
      // No extensions yet
    }
  }

  private async callLLM(): Promise<string> {
    // Use AI Gateway when configured (OpenAI-compatible, supports tools natively)
    if (this.env.AI_GATEWAY_BASE_URL && this.env.AI_GATEWAY_TOKEN) {
      const baseUrl = this.env.AI_GATEWAY_BASE_URL.replace(/\/$/, '');
      const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          messages: this.messages,
          tools: this.buildToolsParam(),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM error: ${response.status} ${text}`);
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ function: { name: string; arguments: string } }>;
          };
        }>;
      };

      const msg = data.choices?.[0]?.message;
      // Native tool call - convert to text format for uniform parsing
      if (msg?.tool_calls?.length) {
        const call = msg.tool_calls[0].function;
        return `TOOL: ${call.name}\nARG: ${call.arguments}`;
      }
      return msg?.content ?? "";
    }

    // Fallback: Workers AI direct endpoint
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: this.messages,
          tools: this.buildToolsParam(),
        }),
      }
    );

    const data = await response.json() as {
      result?: {
        response?: string;
        tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
      };
    };

    // Native tool call from LLM - convert to text format for uniform parsing
    if (data.result?.tool_calls?.length) {
      const call = data.result.tool_calls[0];
      return `TOOL: ${call.name}\nARG: ${JSON.stringify(call.arguments)}`;
    }

    return data.result?.response ?? "";
  }

  private parseToolCall(response: string): { tool: string; args: Record<string, unknown> } | null {
    const toolMatch = response.match(/TOOL:\s*(\w+)/);
    const argMatch = response.match(/ARG:\s*(.+)/s);

    if (!toolMatch) return null;

    const tool = toolMatch[1];
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

  private async executeTool(toolCall: { tool: string; args: Record<string, unknown> }): Promise<ToolResult> {
    const def = this.toolRegistry.get(toolCall.tool);
    if (!def) {
      return { output: "", error: `Unknown tool: ${toolCall.tool}` };
    }
    return def.handler(toolCall.args);
  }

  private async toolRead(path: string): Promise<ToolResult> {
    try {
      const result = await this.env.SANDBOX.readFile(`/workspace/${this.repo}/${path}`);
      return { output: result };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolWrite(path: string, content: string): Promise<ToolResult> {
    try {
      await this.env.SANDBOX.writeFile(`/workspace/${this.repo}/${path}`, content);
      return { output: `Wrote ${path}` };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolEdit(path: string, oldText: string, newText: string): Promise<ToolResult> {
    try {
      const current = await this.env.SANDBOX.readFile(`/workspace/${this.repo}/${path}`);
      if (!current.includes(oldText)) {
        return { output: "", error: "oldText not found in file" };
      }
      const updated = current.replace(oldText, newText);
      await this.env.SANDBOX.writeFile(`/workspace/${this.repo}/${path}`, updated);
      return { output: `Edited ${path}` };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolBash(command: string): Promise<ToolResult> {
    try {
      const result = await this.env.SANDBOX.exec(`cd /workspace/${this.repo} && ${command}`);
      return {
        output: result.stdout,
        error: result.stderr || undefined,
      };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolExtension(name: string, content: string): Promise<ToolResult> {
    try {
      await this.env.SANDBOX.exec(`mkdir -p ${EXTENSIONS_DIR}`);
      const extPath = `${EXTENSIONS_DIR}/${name}.sh`;
      await this.env.SANDBOX.writeFile(extPath, content);
      await this.toolLoad(name);
      return { output: `Extension ${name} written and loaded` };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolLoad(name: string): Promise<ToolResult> {
    try {
      const extPath = `${EXTENSIONS_DIR}/${name}.sh`;
      const result = await this.env.SANDBOX.exec(`source ${extPath} && echo "Extension ${name} loaded"`);
      this.loadedExtensions.add(name);
      return { output: result.stdout };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  // Generate embedding via Workers AI (bge-small-en-v1.5 = 384 dims, free tier)
  private async embed(text: string): Promise<number[] | null> {
    if (!this.env.AI) return null;
    try {
      const result = await this.env.AI.run("@cf/baai/bge-small-en-v1.5", { text }) as { data: number[][] };
      return result.data?.[0] ?? null;
    } catch {
      return null;
    }
  }

  // Persistent memory: KV for exact lookup, Vectorize for semantic search
  private async toolMemory(cmd: string, key?: string, value?: string): Promise<ToolResult> {
    const prefix = `pi:${this.repo}:`;

    try {
      switch (cmd) {
        case "set": {
          if (!key) return { output: "", error: "Key required" };
          await this.env.PI_MEMORY.put(`${prefix}${key}`, value || "");
          if (value && this.env.PI_VECTORS) {
            const vector = await this.embed(`${key}: ${value}`);
            if (vector) {
              await this.env.PI_VECTORS.upsert([{
                id: `${this.repo}:${key}`,
                values: vector,
                metadata: { repo: this.repo, key, text: value, ts: Date.now() },
              }]);
            }
          }
          return { output: `Set ${key}` };
        }

        case "get": {
          if (!key) return { output: "", error: "Key required" };
          const val = await this.env.PI_MEMORY.get(`${prefix}${key}`);
          return { output: val || "" };
        }

        case "list": {
          const keys = await this.env.PI_MEMORY.list({ prefix });
          const keyList = keys.keys.map(k => k.name.replace(prefix, "")).join("\n");
          return { output: keyList || "No memory keys" };
        }

        case "delete": {
          if (!key) return { output: "", error: "Key required" };
          await this.env.PI_MEMORY.delete(`${prefix}${key}`);
          if (this.env.PI_VECTORS) {
            await this.env.PI_VECTORS.deleteByIds([`${this.repo}:${key}`]);
          }
          return { output: `Deleted ${key}` };
        }

        case "search": {
          if (!key) return { output: "", error: "Query required" };
          if (!this.env.PI_VECTORS) return { output: "", error: "Vectorize not available" };
          const vector = await this.embed(key);
          if (!vector) return { output: "", error: "Failed to embed query" };
          const results = await this.env.PI_VECTORS.query(vector, {
            topK: 5,
            filter: { repo: this.repo },
            returnMetadata: "all",
          });
          if (!results.matches.length) return { output: "No relevant memories found" };
          const lines = results.matches.map(m => {
            const meta = m.metadata as { key: string; text: string; ts: number } | undefined;
            const score = m.score.toFixed(3);
            return `[${score}] ${meta?.key ?? m.id}: ${meta?.text ?? ""}`;
          });
          return { output: lines.join("\n") };
        }

        default:
          return { output: "", error: `Unknown memory command: ${cmd}` };
      }
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }
}
