import { LLM_OVERLOAD_RETRY_BASE_MS, LLM_OVERLOAD_RETRY_MAX, MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface CallLLMInput {
  /** Anthropic API key (used for anthropic/ provider) */
  apiKey: string;
  /** OpenAI API key (used for openai/ provider). Falls back to apiKey if absent. */
  openaiApiKey?: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools?: unknown[];
  taskComplexityHint?: "routine" | "complex";
  model?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Cloudflare account ID – routes requests through AI Gateway when set together with gatewayId */
  gatewayAccountId?: string;
  /** AI Gateway name/slug – routes requests through AI Gateway when set together with gatewayAccountId */
  gatewayId?: string;
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

// ─── Model / provider helpers ────────────────────────────────────────────────

/**
 * Parses a "provider/model-name" string.
 * Models without a slash are assumed to be Anthropic.
 */
export function parseModel(modelStr: string): { provider: string; model: string } {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx === -1) return { provider: "anthropic", model: modelStr };
  return { provider: modelStr.slice(0, slashIdx), model: modelStr.slice(slashIdx + 1) };
}

/**
 * Returns the Cloudflare AI Gateway URL for the given account, gateway, and provider.
 * The URL includes the provider-specific endpoint path.
 */
export function buildGatewayUrl(accountId: string, gatewayId: string, provider: string): string {
  const endpoint = provider === "openai" ? "/v1/chat/completions" : "/v1/messages";
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}${endpoint}`;
}

function getDirectUrl(provider: string): string {
  return provider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : "https://api.anthropic.com/v1/messages";
}

// ─── Anthropic → OpenAI request adapters ─────────────────────────────────────

function toOpenAIMessages(systemPrompt: string, messages: AnthropicMessage[]): unknown[] {
  const result: unknown[] = [{ role: "system", content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const blocks = msg.content as Array<Record<string, unknown>>;
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const rawContent = block.content;
            const text = Array.isArray(rawContent)
              ? (rawContent as Array<Record<string, unknown>>).map((c) => c.text ?? "").join("\n")
              : String(rawContent ?? "");
            result.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
          } else if (block.type === "text") {
            result.push({ role: "user", content: block.text });
          }
        }
      }
    } else {
      // assistant
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else {
        const blocks = msg.content as Array<Record<string, unknown>>;
        const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text as string);
        const toolUses = blocks.filter((b) => b.type === "tool_use");
        const assistantMsg: Record<string, unknown> = {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("\n") : null
        };
        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((b) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
          }));
        }
        result.push(assistantMsg);
      }
    }
  }
  return result;
}

function toOpenAITools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    const t = tool as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    };
  });
}

// ─── OpenAI response → Anthropic LLMResponse adapter ─────────────────────────

function fromOpenAIResponse(data: Record<string, unknown>): LLMResponse {
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const finishReason = choice?.finish_reason as string | undefined;

  const content: unknown[] = [];
  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of (message?.tool_calls as Array<Record<string, unknown>>) ?? []) {
    const fn = toolCall.function as Record<string, unknown>;
    let input: unknown;
    try {
      input = JSON.parse(fn.arguments as string);
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: toolCall.id, name: fn.name, input });
  }

  const usage = data.usage as Record<string, number> | undefined;
  return {
    id: data.id as string,
    model: data.model as string,
    content,
    stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0
    }
  };
}

// ─── Model selection ──────────────────────────────────────────────────────────

const COMPLEXITY_PATTERN = /(complex|refactor|architecture|multi-step|analy[sz]e|reason)/i;

export function selectModel(
  systemPrompt: string,
  messages: AnthropicMessage[],
  taskComplexityHint?: "routine" | "complex"
): string {
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

// ─── Main LLM call ────────────────────────────────────────────────────────────

export async function callLLM(input: CallLLMInput): Promise<LLMResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl =
    input.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const rawModel =
    input.model ?? selectModel(input.systemPrompt, input.messages, input.taskComplexityHint);
  const { provider, model } = parseModel(rawModel);
  const isOpenAI = provider === "openai";

  const url =
    input.gatewayAccountId && input.gatewayId
      ? buildGatewayUrl(input.gatewayAccountId, input.gatewayId, provider)
      : getDirectUrl(provider);

  const requestBody = isOpenAI
    ? JSON.stringify({
        model,
        max_tokens: 1024,
        messages: toOpenAIMessages(input.systemPrompt, input.messages),
        ...(input.tools?.length ? { tools: toOpenAITools(input.tools) } : {})
      })
    : JSON.stringify({
        model,
        max_tokens: 1024,
        system: [{ type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } }],
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

  const headers: Record<string, string> = isOpenAI
    ? {
        "content-type": "application/json",
        authorization: `Bearer ${input.openaiApiKey ?? input.apiKey}`
      }
    : {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "x-api-key": input.apiKey
      };

  for (let attempt = 0; attempt <= LLM_OVERLOAD_RETRY_MAX; attempt++) {
    const response = await fetchImpl(url, { method: "POST", headers, body: requestBody });

    if (response.ok) {
      const data = await response.json();
      return isOpenAI
        ? fromOpenAIResponse(data as Record<string, unknown>)
        : (data as LLMResponse);
    }

    if ((response.status === 529 || response.status === 429) && attempt < LLM_OVERLOAD_RETRY_MAX) {
      const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
      await sleepImpl(waitMs);
      continue;
    }

    const errorText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errorText}`);
  }

  throw new Error("LLM API error: max retries exceeded");
}
