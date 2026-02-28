import type { Env } from "./types";

export interface ModelConfig {
  id: string;
  name: string;
  maxTokens: number;
  complexity: "simple" | "medium" | "complex";
  cost: "low" | "medium" | "high";
}

// Available models in Cloudflare AI Gateway
export const MODELS: Record<string, ModelConfig> = {
  fast: {
    id: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    name: "Llama 3.1 8B",
    maxTokens: 2048,
    complexity: "simple",
    cost: "low"
  },
  balanced: {
    id: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B Fast",
    maxTokens: 4096,
    complexity: "medium",
    cost: "medium"
  },
  powerful: {
    id: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
    name: "Llama 4 Scout",
    maxTokens: 8192,
    complexity: "complex",
    cost: "high"
  }
};

export async function classifyComplexity(
  task: string,
  env: Env
): Promise<"simple" | "medium" | "complex"> {
  const prompt = `Classify this task complexity: "${task}"
  
Simple: greetings, simple questions, status checks, one-line answers
Medium: explanations, code review, planning, multi-step tasks  
Complex: architecture decisions, complex debugging, large refactors, research

Respond with only: simple, medium, or complex`;

  try {
    const response = await callRouterLLM(prompt, env);
    const clean = response.toLowerCase().trim();
    if (clean.includes("simple")) return "simple";
    if (clean.includes("complex")) return "complex";
    return "medium";
  } catch {
    return "medium";
  }
}

export function selectModel(complexity: "simple" | "medium" | "complex"): ModelConfig {
  switch (complexity) {
    case "simple": return MODELS.fast;
    case "complex": return MODELS.powerful;
    default: return MODELS.balanced;
  }
}

async function callRouterLLM(prompt: string, env: Env): Promise<string> {
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
      model: MODELS.fast.id,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
    }),
  });

  if (!response.ok) {
    throw new Error(`Router error: ${response.status}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "medium";
}
