import type { Env } from "./types";

export interface ModelConfig {
  id: string;
  name: string;
  maxTokens: number;
  description: string;
}

// Available models via AI Gateway
export const MODELS: Record<string, ModelConfig> = {
  // Free tier - Cloudflare Workers AI
  "llama-3.3-70b": {
    id: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B",
    maxTokens: 4096,
    description: "Fast, capable model for most tasks. Free tier."
  },
  "llama-4-scout": {
    id: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
    name: "Llama 4 Scout",
    maxTokens: 8192,
    description: "More powerful, multimodal. Free tier."
  },
  
  // Paid models - via AI Gateway
  "claude-sonnet": {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    maxTokens: 8192,
    description: "Excellent for complex reasoning and coding. Paid."
  },
  "gpt-4": {
    id: "openai/gpt-4",
    name: "GPT-4",
    maxTokens: 8192,
    description: "Powerful general-purpose model. Paid."
  }
};

// Default starting model
export const DEFAULT_MODEL = "llama-3.3-70b";

// Models to try in order of capability (for escalation)
export const ESCALATION_CHAIN = [
  "llama-3.3-70b",
  "llama-4-scout", 
  "claude-sonnet",
  "gpt-4"
];
