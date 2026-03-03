// pi-agent.ts - Minimal Pi-style agent with 4 tools: read, write, edit, bash
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

// System prompt - minimal, like Pi
const SYSTEM_PROMPT = `You are a helpful coding assistant. You have 4 tools:

1. read(path) - Read file contents
2. write(path, content) - Write file (overwrites)
3. edit(path, oldText, newText) - Replace text in file
4. bash(command) - Execute shell command

When you need to use a tool, output:
TOOL: tool_name
ARG: argument (JSON)

Then wait for the result. Continue until the task is complete.
Be concise. Don't ask for confirmation. Just do it.`;

export class PiAgent {
  private messages: PiMessage[] = [];
  
  constructor(
    private env: Env,
    private repo: string
  ) {
    this.messages.push({ role: "system", content: SYSTEM_PROMPT });
  }

  async run(userMessage: string): Promise<string> {
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
}