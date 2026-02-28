import type { Env } from "./types";

// Model catalog - populated from AI Gateway configuration
// These are the models available via your AI Gateway
export const MODEL_CATALOG: Record<string, { name: string; description: string; maxTokens: number }> = {
  // Free tier - Cloudflare Workers AI
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
    name: "Llama 3.3 70B Fast",
    description: "Fast, capable model for most coding tasks. Free tier.",
    maxTokens: 4096
  },
  "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct": {
    name: "Llama 4 Scout",
    description: "More powerful, multimodal, mixture-of-experts. Free tier.",
    maxTokens: 8192
  },
  "workers-ai/@cf/meta/llama-3.1-8b-instruct": {
    name: "Llama 3.1 8B",
    description: "Fast, lightweight. Good for simple tasks. Free tier.",
    maxTokens: 2048
  },
  
  // Paid models - via AI Gateway (add your own)
  "anthropic/claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    description: "Excellent for complex reasoning and coding. Paid.",
    maxTokens: 8192
  },
  "openai/gpt-4": {
    name: "GPT-4",
    description: "Powerful general-purpose model. Paid.",
    maxTokens: 8192
  },
  "openai/gpt-4o": {
    name: "GPT-4o",
    description: "Fast, multimodal, very capable. Paid.",
    maxTokens: 4096
  }
};

// Default model to start with
export const DEFAULT_MODEL = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Generate model catalog description for system prompt
export function getModelCatalogDescription(): string {
  return Object.entries(MODEL_CATALOG)
    .map(([id, info]) => `- ${id}: ${info.name} - ${info.description} (max ${info.maxTokens} tokens)`)
    .join("\n");
}