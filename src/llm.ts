import { LLM_OVERLOAD_RETRY_BASE_MS, LLM_OVERLOAD_RETRY_MAX, MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface CallLLMInput {
  apiKey: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools?: unknown[];
  taskComplexityHint?: "routine" | "complex";
  model?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
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

  const containsComplexToolIntent = messages.some((msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return /tool|bash|run command|test suite|migration/i.test(content) && /complex|large|deep/i.test(content);
  });

  return containsComplexToolIntent ? MODEL_COMPLEX : MODEL_ROUTINE;
}

export async function callLLM(input: CallLLMInput): Promise<LLMResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const model = input.model ?? selectModel(input.systemPrompt, input.messages, input.taskComplexityHint);

  const requestBody = JSON.stringify({
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
  });

  for (let attempt = 0; attempt <= LLM_OVERLOAD_RETRY_MAX; attempt++) {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-api-key": input.apiKey
      },
      body: requestBody
    });

    if (response.ok) {
      return (await response.json()) as LLMResponse;
    }

    if ((response.status === 529 || response.status === 429) && attempt < LLM_OVERLOAD_RETRY_MAX) {
      const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
      await sleepImpl(waitMs);
      continue;
    }

    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  // Unreachable: the final attempt either returns or throws above.
  throw new Error("Anthropic API error: max retries exceeded");
}
