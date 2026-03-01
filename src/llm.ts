import type { Env } from "./types";
import { DEFAULT_MODEL, getModelCatalogDescription } from "./models";

// Cache for model catalog description (refreshed every 5 minutes)
let catalogCache: { description: string; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface LLMResponse {
  content: string;
  modelUsed: string;
  modelSwitched: boolean;
}

async function getCachedCatalogDescription(env: Env): Promise<string> {
  if (catalogCache && Date.now() - catalogCache.timestamp < CACHE_TTL) {
    return catalogCache.description;
  }
  const description = await getModelCatalogDescription(env);
  catalogCache = { description, timestamp: Date.now() };
  return description;
}

export async function callLLMWithModelSelection(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<LLMResponse> {
  const userMessage = messages.find(m => m.role === "user")?.content ?? "";
  
  // Get catalog description from cache
  const catalogDesc = await getCachedCatalogDescription(env);
  
  // First call: let the model pick which model to use
  const modelPickerMessages = [
    { 
      role: "system", 
      content: `You are a model selector. Available models:\n${catalogDesc}\n\nRespond with ONLY the model ID that would be best for this task. Default: ${DEFAULT_MODEL}` 
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
  const validModels = catalogDesc.split("\n").map(line => line.split(":")[0].replace("- ", "").trim());
  const modelId = validModels.includes(selectedModelId.trim()) ? selectedModelId.trim() : DEFAULT_MODEL;
  
  // Extract model info from cached catalog
  const modelLine = catalogDesc.split("\n").find(line => line.includes(modelId));
  const modelName = modelLine ? modelLine.split(":")[1]?.split("-")[0].trim() : modelId;
  const maxTokensMatch = modelLine?.match(/max (\d+) tokens/);
  const maxTokens = maxTokensMatch ? parseInt(maxTokensMatch[1]) : 4096;
  
  // Second call: actually process the request with selected model
  const response = await callLLMRaw(messages, modelId, opts.maxTokens ?? maxTokens, env);

  return {
    content: response,
    modelUsed: modelName,
    modelSwitched: modelId !== DEFAULT_MODEL
  };
}

async function callLLMRaw(
  messages: Array<{ role: string; content: string }>,
  modelId: string,
  maxTokens: number,
  env: Env
): Promise<string> {
  // Fallback to Workers AI if gateway not configured
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    // Use Workers AI directly
    const ai = (env as any).AI as { run: (model: string, inputs: { messages: typeof messages; max_tokens: number }) => Promise<{ response?: string }> };
    if (!ai) {
      throw new Error("Neither AI Gateway nor Workers AI available");
    }
    const result = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages,
      max_tokens: maxTokens,
    });
    return result.response ?? "";
  }

  // Ensure URL ends with /chat/completions for OpenAI-compatible endpoint
  const baseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/$/, '');
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

  const response = await fetch(url, {
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

// Plan function for agent
export async function plan(goals: string[], env: Env): Promise<string> {
  const prompt = `You are a helpful AI assistant working on code.

Repository goals:
${goals.map(g => `- ${g}`).join("\n")}

What is ONE specific task to work on next? Respond with only the task description.`;
  return (await callLLM([{ role: "user", content: prompt }], env)).trim();
}
