import { MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallLLMInput {
  apiKey: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools?: unknown[];
  taskComplexityHint?: "routine" | "complex";
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: unknown[];
  stop_reason: string | null;
  usage: LLMUsage;
}

const COMPLEXITY_PATTERN = /(complex|refactor|architecture|multi-step|analy[sz]e|reason)/i;

export function selectModel(systemPrompt: string, messages: AnthropicMessage[], taskComplexityHint?: "routine" | "complex"): string {
  if (taskComplexityHint === "complex") {
    return MODEL_COMPLEX;
  }

  if (COMPLEXITY_PATTERN.test(systemPrompt)) {
    return MODEL_COMPLEX;
  }

  const containsComplexToolIntent = messages.some((msg) =>
    /tool|bash|run command|test suite|migration/i.test(msg.content) && /complex|large|deep/i.test(msg.content)
  );

  return containsComplexToolIntent ? MODEL_COMPLEX : MODEL_ROUTINE;
}

export async function callLLM(input: CallLLMInput): Promise<LLMResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const model = input.model ?? selectModel(input.systemPrompt, input.messages, input.taskComplexityHint);

  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "x-api-key": input.apiKey
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: input.systemPrompt,
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: input.messages,
      ...(input.tools?.length
        ? {
            tools: input.tools.map((tool) => ({
              ...(tool as Record<string, unknown>),
              cache_control: { type: "ephemeral" }
            }))
          }
        : {})
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const parsed = (await response.json()) as LLMResponse;
  return parsed;
}
