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

const EXTENSIONS_DIR = "/workspace/.blob/extensions";

// System prompt - minimal, like Pi, with extension support
const SYSTEM_PROMPT = `You are a helpful coding assistant. You have 4 core tools:

1. read(path) - Read file contents
2. write(path, content) - Write file (overwrites)
3. edit(path, oldText, newText) - Replace text in file
4. bash(command) - Execute shell command

You also have persistent memory:
5. memory(cmd, key, value?) - Memory operations: set, get, list, delete, search
   - set/get/list/delete: exact key-value operations
   - search: semantic search, key is the natural language query (e.g. memory("search", "auth token setup"))

Extensions are bash scripts that add new capabilities. Write them to extend your abilities.

When you need to use a tool, output:
TOOL: tool_name
ARG: argument (JSON)

Then wait for the result. Continue until the task is complete.
Be concise. Don't ask for confirmation. Just do it.`;

export class PiAgent {
  private messages: PiMessage[] = [];
  private loadedExtensions: Set<string> = new Set();
  
  constructor(
    private env: Env,
    private repo: string
  ) {
    this.messages.push({ role: "system", content: SYSTEM_PROMPT });
  }

  async run(userMessage: string): Promise<string> {
    // Auto-load existing extensions
    await this.autoLoadExtensions();
    
    this.messages.push({ role: "user", content: userMessage });
    
    let iterations = 0;
    const maxIterations = 10;
    
    while (iterations < maxIterations) {
      iterations++;
      
      // Single LLM call
      const response = await this.callLLM();
      
      // Check if response contains tool calls
      const toolCall = this.parseToolCall(response);
      
      if (!toolCall) {
        // No tool call - return final response
        this.messages.push({ role: "assistant", content: response });
        return response;
      }
      
      // Execute tool
      const result = await this.executeTool(toolCall);
      
      // Add tool result to context
      this.messages.push({ 
        role: "assistant", 
        content: `TOOL: ${toolCall.tool}\nARG: ${JSON.stringify(toolCall.args)}\n\nRESULT: ${result.output}${result.error ? `\nERROR: ${result.error}` : ''}` 
      });
    }
    
    return "Reached maximum iterations. Task may be incomplete.";
  }

  private async autoLoadExtensions(): Promise<void> {
    try {
      // List extensions directory
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
    const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + this.env.ACCOUNT_ID + "/ai/run/@cf/meta/llama-3.1-8b-instruct", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: this.messages
      })
    });
    
    const data = await response.json() as { result?: { response?: string } };
    return data.result?.response || "No response from LLM";
  }

  private parseToolCall(response: string): { tool: string; args: any } | null {
    const toolMatch = response.match(/TOOL:\s*(\w+)/);
    const argMatch = response.match(/ARG:\s*(.+)/s);
    
    if (!toolMatch) return null;
    
    const tool = toolMatch[1];
    let args = {};
    
    if (argMatch) {
      try {
        args = JSON.parse(argMatch[1].trim());
      } catch {
        args = { raw: argMatch[1].trim() };
      }
    }
    
    return { tool, args };
  }

  private async executeTool(toolCall: { tool: string; args: any }): Promise<ToolResult> {
    switch (toolCall.tool) {
      case "read":
        return await this.toolRead(toolCall.args.path);
      case "write":
        return await this.toolWrite(toolCall.args.path, toolCall.args.content);
      case "edit":
        return await this.toolEdit(toolCall.args.path, toolCall.args.oldText, toolCall.args.newText);
      case "bash":
        return await this.toolBash(toolCall.args.command);
      case "extension":
        return await this.toolExtension(toolCall.args.name, toolCall.args.content);
      case "load":
        return await this.toolLoad(toolCall.args.name);
      case "memory":
        return await this.toolMemory(toolCall.args.cmd, toolCall.args.key, toolCall.args.value);
      default:
        return { output: "", error: `Unknown tool: ${toolCall.tool}` };
    }
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
        error: result.stderr || undefined
      };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolExtension(name: string, content: string): Promise<ToolResult> {
    try {
      // Ensure extensions dir exists
      await this.env.SANDBOX.exec(`mkdir -p ${EXTENSIONS_DIR}`);
      
      // Write extension
      const extPath = `${EXTENSIONS_DIR}/${name}.sh`;
      await this.env.SANDBOX.writeFile(extPath, content);
      
      // Auto-load it
      await this.toolLoad(name);
      
      return { output: `Extension ${name} written and loaded` };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }

  private async toolLoad(name: string): Promise<ToolResult> {
    try {
      const extPath = `${EXTENSIONS_DIR}/${name}.sh`;
      
      // Source the extension in bash
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
          // Also embed and upsert into Vectorize for semantic recall
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
          // key is reused as the search query here
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