import type { Env } from "./types";
import { classifyComplexity, selectModel } from "./models";

export async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number; model?: string } = {}
): Promise<string> {
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    throw new Error("AI Gateway not configured");
  }

  const response = await fetch(`${env.AI_GATEWAY_BASE_URL}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      messages,
      max_tokens: opts.maxTokens ?? 4096,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM error: ${response.status} ${text}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  
  if (!data.choices || data.choices.length === 0) {
    throw new Error("No choices in LLM response");
  }
  
  return data.choices[0]?.message?.content ?? "";
}

export async function callLLMWithRouting(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  taskDescription: string
): Promise<string> {
  const complexity = await classifyComplexity(taskDescription, env);
  const model = selectModel(complexity);
  
  return callLLM(messages, env, { 
    model: model.id, 
    maxTokens: model.maxTokens 
  });
}

export async function plan(goals: string[], env: Env): Promise<string> {
  const prompt = `You are an autonomous coding agent.\n\nRepository goals:\n${goals.map(g => `- ${g}`).join("\n")}\n\nWhat is ONE specific task to work on next? Respond with only the task description.`;
  return (await callLLM([{ role: "user", content: prompt }], env)).trim();
}
