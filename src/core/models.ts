import type { Env } from "./types";
import { getModelCatalog } from "./memory-system";

// Default model for AI Gateway (OpenAI-compatible endpoint)
export const DEFAULT_MODEL = "workers-ai/@cf/nvidia/nemotron-3-120b-a12b";

// Free fallback model for Workers AI (used when AI Gateway is not configured)
export const WORKERS_AI_FALLBACK_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";

// Workers AI model routed through AI Gateway (OpenAI-compatible endpoint)
export const WORKERS_AI_GATEWAY_MODEL = "workers-ai/@cf/nvidia/nemotron-3-120b-a12b";

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
