import type { Env } from "./types";
import { MODELS, DEFAULT_MODEL, ESCALATION_CHAIN } from "./models";

interface LLMResponse {
  content: string;
  escalated: boolean;
  modelUsed: string;
}

export async function callLLMWithEscalation(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number; startModel?: string } = {}
): Promise<LLMResponse> {
  const startModelKey = opts.startModel ?? DEFAULT_MODEL;
  const startModel = MODELS[startModelKey];
  
  if (!startModel) {
    throw new Error(`Unknown model: ${startModelKey}`);
  }

  // Try with starting model
  const systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
  const userMessage = messages.find(m => m.role === "user")?.content ?? "";
  
  const augmentedMessages = [
    { 
      role: "system", 
      content: `${systemPrompt}\n\nIf this task is too complex for you, respond with [[ESCALATE:reason]] and nothing else. Otherwise, respond normally.` 
    },
    { role: "user", content: userMessage }
  ];

  const firstResponse = await callLLMRaw(augmentedMessages, startModel.id, opts.maxTokens ?? startModel.maxTokens, env);
  
  // Check if escalation requested
  const escalateMatch = firstResponse.match(/\[\[ESCALATE:(.+?)\]\]/);
  
  if (!escalateMatch) {
    // No escalation needed
    return {
      content: firstResponse,
      escalated: false,
      modelUsed: startModel.name
    };
  }

  // Escalate to next model in chain
  const escalateReason = escalateMatch[1];
  const currentIndex = ESCALATION_CHAIN.indexOf(startModelKey);
  const nextModelKey = ESCALATION_CHAIN[currentIndex + 1];
  
  if (!nextModelKey) {
    // No more models to try
    return {
      content: firstResponse.replace(/\[\[ESCALATE:.+?\]\]/, "").trim(),
      escalated: false,
      modelUsed: startModel.name
    };
  }

  const nextModel = MODELS[nextModelKey];
  
  // Retry with more powerful model
  const retryMessages = [
    { 
      role: "system", 
      content: `${systemPrompt}\n\nThe previous model requested escalation because: ${escalateReason}. You are the specialized model handling this complex task.` 
    },
    { role: "user", content: userMessage }
  ];

  const secondResponse = await callLLMRaw(retryMessages, nextModel.id, opts.maxTokens ?? nextModel.maxTokens, env);

  return {
    content: secondResponse,
    escalated: true,
    modelUsed: nextModel.name
  };
}

async function callLLMRaw(
  messages: Array<{ role: string; content: string }>,
  modelId: string,
  maxTokens: number,
  env: Env
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
      model: modelId,
      messages,
      max_tokens: maxTokens,
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

// Simple call without escalation (for internal use)
export async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const result = await callLLMWithEscalation(messages, env, opts);
  return result.content;
}
