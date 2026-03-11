import type { Env } from "./types";
import { DEFAULT_MODEL, WORKERS_AI_FALLBACK_MODEL, getCatalog } from "./models";

interface CatalogModel {
  name: string;
  description: string;
  maxTokens: number;
}

// Cache for model catalog (refreshed every 5 minutes)
let catalogCache: { catalog: Record<string, CatalogModel>; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface LLMResponse {
  content: string;
  modelUsed: string;
  modelSwitched: boolean;
}

async function getCachedCatalog(env: Env): Promise<Record<string, CatalogModel>> {
  if (catalogCache && Date.now() - catalogCache.timestamp < CACHE_TTL) {
    return catalogCache.catalog;
  }
  const catalog = await getCatalog(env);
  catalogCache = { catalog, timestamp: Date.now() };
  return catalog;
}

function isDifficultTask(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const difficultKeywords = [
    "architecture",
    "refactor",
    "root cause",
    "debug",
    "performance",
    "optimize",
    "security",
    "migration",
    "multi-file",
    "design a",
    "complex"
  ];

  const hasKeyword = difficultKeywords.some(keyword => normalized.includes(keyword));
  const isLongPrompt = normalized.length > 600;

  return hasKeyword || isLongPrompt;
}

function pickModel(catalog: Record<string, CatalogModel>, userMessage: string, env?: Env): { modelId: string; modelName: string; maxTokens: number } {
  // Allow env override for model selection
  const envModel = env?.LLM_MODEL;
  if (envModel) {
    return { modelId: envModel, modelName: envModel, maxTokens: 8192 };
  }

  const entries = Object.entries(catalog);
  if (entries.length === 0) {
    return {
      modelId: DEFAULT_MODEL,
      modelName: DEFAULT_MODEL,
      maxTokens: 8192
    };
  }

  const mainModelId = catalog[DEFAULT_MODEL] ? DEFAULT_MODEL : entries[0][0];
  const codexEntry = entries.find(([id, info]) => {
    const haystack = `${id} ${info.name} ${info.description}`.toLowerCase();
    return haystack.includes("codex");
  });

  if (codexEntry && isDifficultTask(userMessage)) {
    const [modelId, info] = codexEntry;
    return { modelId, modelName: info.name, maxTokens: info.maxTokens };
  }

  const main = catalog[mainModelId];
  return {
    modelId: mainModelId,
    modelName: main.name,
    maxTokens: main.maxTokens
  };
}

export async function callLLMWithModelSelection(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<LLMResponse> {
  const userMessage = messages.find(m => m.role === "user")?.content ?? "";
  const catalog = await getCachedCatalog(env);
  const selection = pickModel(catalog, userMessage, env);
  
  const response = await callLLMRaw(messages, selection.modelId, opts.maxTokens ?? selection.maxTokens, env);

  return {
    content: response,
    modelUsed: selection.modelName,
    modelSwitched: selection.modelId !== DEFAULT_MODEL
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
    const result = await ai.run(WORKERS_AI_FALLBACK_MODEL, {
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
      "cf-aig-cache-ttl": "3600", // Cache identical requests for 1 hour
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
  
  const content = data.choices[0]?.message?.content ?? "";
  return typeof content === "string" ? content : JSON.stringify(content);
}

// Simple call without model selection
export async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number; model?: string } = {}
): Promise<string> {
  if (opts.model) {
    return callLLMRaw(messages, opts.model, opts.maxTokens ?? 8192, env);
  }
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
