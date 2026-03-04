import type { Env } from "./types";
import { getModelCatalog } from "./memory";

// Default catalog (fallback if DO is empty)
export const DEFAULT_MODEL = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Get catalog from DO (async)
export async function getCatalog(env: Env): Promise<Record<string, { name: string; description: string; maxTokens: number }>> {
  return await getModelCatalog(env);
}

// Generate model catalog description for system prompt
export async function getModelCatalogDescription(env: Env): Promise<string> {
  const catalog = await getCatalog(env);
  return Object.entries(catalog)
    .map(([id, info]) => `- ${id}: ${info.name} - ${info.description} (max ${info.maxTokens} tokens)`)
    .join("\n");
}