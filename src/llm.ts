import type { Env } from "./types";
import { MODEL_CATALOG, DEFAULT_MODEL, getModelCatalogDescription } from "./models";

interface LLMResponse {
  content: string;
  modelUsed: string;
  modelSwitched: boolean;
}

export async function callLLMWithModelSelection(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<LLMResponse> {
  const systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
  const userMessage = messages.find(m => m.role === "user")?.content ?? "";
  
  // First call: let the model pick which model to use
  const modelPickerMessages = [
    { 
      role: "system", 
      content: `You are a model selector. Available models:\n${getModelCatalogDescription()}\n\nRespond with ONLY the model ID that would be best for this task. Default: ${DEFAULT_MODEL}` 
    },
    { role: "user", content: userMessage }
  ];

  const selectedModelId = await callLLMRaw(
    modelPickerMessages, 
    DEFAULT_MODEL, 
    100, 
    env
  );

  // Validate the selection
  const modelId = MODEL_CATALOG[selectedModelId.trim()] ? selectedModelId.trim() : DEFAULT_MODEL;
  const modelInfo = MODEL_CATALOG[modelId];
  
  // Second call: actually process the request with selected model
  const maxTokens = opts.maxTokens ?? modelInfo.maxTokens;
  const response = await callLLMRaw(messages, modelId, maxTokens, env);

  return {
    content: response,
    modelUsed: modelInfo.name,
    modelSwitched: modelId !== DEFAULT_MODEL
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

// Simple call without model selection
export async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const result = await callLLMWithModelSelection(messages, env, opts);
  return result.content;
}
