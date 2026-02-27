/**
 * Lightweight Workers AI client for fast local inference.
 * Uses env.AI binding - no external API calls, no latency.
 */

import { WORKERS_AI_CHAT } from "./config";

export interface WorkersAIInput {
  env: { AI?: unknown };
  model?: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}

export interface WorkersAIResponse {
  text: string;
  model: string;
}

/**
 * Call Workers AI for fast local inference.
 * This uses the local AI binding - no network hop, very low latency.
 */
export async function callWorkersAI(input: WorkersAIInput): Promise<WorkersAIResponse> {
  const model = input.model ?? WORKERS_AI_CHAT;

  if (!input.env.AI) {
    throw new Error("Workers AI binding not available");
  }

  // Build prompt from system + messages
  const prompt = buildPrompt(input.systemPrompt, input.messages);

  const ai = input.env.AI as { run: (model: string, options: { prompt: string; max_tokens: number; temperature: number }) => Promise<{ response?: string }> };
  const response = await ai.run(model, {
    prompt,
    max_tokens: input.maxTokens ?? 1024,
    temperature: 0.7,
  });

  return {
    text: String(response.response ?? ""),
    model
  };
}

function buildPrompt(systemPrompt: string, messages: Array<{ role: string; content: string }>): string {
  let prompt = systemPrompt ? `${systemPrompt}\n\n` : "";

  for (const msg of messages) {
    if (msg.role === "user") {
      prompt += `User: ${msg.content}\n`;
    } else {
      prompt += `Assistant: ${msg.content}\n`;
    }
  }

  prompt += "Assistant:";
  return prompt;
}

/**
 * Check if Workers AI is available and suitable for the task.
 * Use for: simple chat, greetings, factual questions, time queries.
 * Don't use for: complex reasoning, code generation, multi-step tasks.
 */
export function shouldUseWorkersAI(task: string): boolean {
  // Fast patterns that work well with local LLM
  const fastPatterns = [
    /^(hi|hello|hey|yo|sup)\b/i,
    /^(thanks|thank you|ty)\b/i,
    /^(ok|okay|got it)\b/i,
    /^(yes|no|maybe)\b/i,
    /^(cool|nice|awesome|great)\b/i,
    /what\s+time\s+is\s+it/i,
    /what's\s+the\s+time/i,
    /current\s+time/i,
    /what\s+day\s+is\s+it/i,
    /what\s+(model|ai|llm)\s+are\s+you/i,
    /who\s+(made|built|created)\s+you/i,
    /what\s+can\s+you\s+do/i,
    /how\s+do\s+you\s+work/i,
    /where\s+are\s+you\s+hosted/i,
    /^(bye|goodbye|cya)\b/i,
  ];

  return fastPatterns.some(p => p.test(task.trim()));
}