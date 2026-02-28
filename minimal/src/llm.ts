/**
 * LLM integration using Cloudflare AI Gateway.
 */

import type { Env } from "./types";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  text: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/**
 * Call LLM via Cloudflare AI Gateway.
 */
export async function callLLM(
  messages: LLMMessage[],
  env: Env,
  options: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<LLMResponse> {
  const model = options.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8";
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;
  
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    throw new Error("AI Gateway not configured");
  }
  
  const response = await globalThis.fetch(`${env.AI_GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`LLM error: ${response.status} ${await response.text()}`);
  }
  
  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  
  return {
    text: data.choices[0]?.message?.content ?? "",
    usage: data.usage,
  };
}

/**
 * Generate a plan based on goals.
 */
export async function generatePlan(
  goals: string[],
  env: Env
): Promise<string> {
  const systemPrompt = `You are an autonomous coding agent.

Your job is to analyze the codebase and decide what to work on next.

Guidelines:
- Pick ONE concrete, actionable task
- Focus on the repository goals
- Be specific about what files to modify
- Consider dependencies and side effects

Respond with only the task description. No markdown, no explanation.`;

  const goalsText = goals.map(g => `- ${g}`).join("\n");
  
  const response = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Repository goals:\n${goalsText}\n\nWhat should I work on next?` }
  ], env);
  
  return response.text.trim();
}

/**
 * Execute a task using tools.
 */
export async function executeWithTools(
  task: string,
  toolResults: string[],
  env: Env
): Promise<{ action: string; args: Record<string, unknown> } | string> {
  const systemPrompt = `You are an autonomous coding agent executing a task.

Task: ${task}

You have these tools:
- read(path): Read a file
- write(path, content): Write a file  
- edit(path, oldText, newText): Edit a file
- bash(command): Run a shell command
- search(query): Search code
- createPR(title, branch): Create a PR

Previous actions:\n${toolResults.join("\n")}

Decide the next action. Respond in JSON:
{"tool": "toolName", "args": {...}}

Or if done, respond with:
{"done": true, "summary": "what you accomplished"}`;

  const response = await callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: "What should I do next?" }
  ], env, { temperature: 0.3 });
  
  try {
    return JSON.parse(response.text);
  } catch {
    return response.text;
  }
}
