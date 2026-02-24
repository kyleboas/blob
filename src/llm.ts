import { LLM_OVERLOAD_RETRY_BASE_MS, LLM_OVERLOAD_RETRY_MAX, MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface CallLLMInput {
  apiKey?: string;
  openAiApiKey?: string;
  aiGatewayToken?: string;
  aiGatewayBaseUrl?: string;
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

function isOpenAIModel(model: string): boolean {
  return /^gpt-|^o[1-9]|^o\d/.test(model);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function toOpenAITools(tools: unknown[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    const anthropicTool = tool as { name?: string; description?: string; input_schema?: unknown };
    return {
      type: "function",
      function: {
        name: anthropicTool.name,
        description: anthropicTool.description,
        parameters: anthropicTool.input_schema
      }
    };
  });
}

function toOpenAIMessages(systemPrompt: string, messages: AnthropicMessage[]): Array<Record<string, unknown>> {
  const openAiMessages: Array<Record<string, unknown>> = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      openAiMessages.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];

    if (message.role === "assistant") {
      const textContent = blocks
        .filter((block) => (block as { type?: string }).type === "text")
        .map((block) => String((block as { text?: string }).text ?? ""))
        .join("\n")
        .trim();

      const toolCalls = blocks
        .filter((block) => (block as { type?: string }).type === "tool_use")
        .map((block) => {
          const tool = block as { id?: string; name?: string; input?: unknown };
          return {
            id: tool.id,
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input ?? {})
            }
          };
        });

      if (toolCalls.length > 0) {
        openAiMessages.push({ role: "assistant", content: textContent || null, tool_calls: toolCalls });
      } else {
        openAiMessages.push({ role: "assistant", content: textContent });
      }
      continue;
    }

    const toolResults = blocks.filter((block) => (block as { type?: string }).type === "tool_result");
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        const result = block as { tool_use_id?: string; content?: Array<{ text?: string }> };
        const text = (result.content ?? []).map((entry) => entry.text ?? "").join("\n") || "(no output)";
        openAiMessages.push({ role: "tool", tool_call_id: result.tool_use_id, content: text });
      }
    } else {
      openAiMessages.push({ role: "user", content: JSON.stringify(message.content) });
    }
  }

  return openAiMessages;
}

function toAnthropicLikeResponse(payload: Record<string, any>, fallbackModel: string): LLMResponse {
  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: unknown[] = [];

  if (typeof message.content === "string" && message.content.trim()) {
    content.push({ type: "text", text: message.content });
  }

  for (const toolCall of message.tool_calls ?? []) {
    const argsRaw = toolCall?.function?.arguments;
    let parsedArgs: Record<string, unknown> = {};
    if (typeof argsRaw === "string" && argsRaw.trim()) {
      try {
        parsedArgs = JSON.parse(argsRaw) as Record<string, unknown>;
      } catch {
        parsedArgs = { _raw: argsRaw };
      }
    }

    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall?.function?.name,
      input: parsedArgs
    });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: payload.id ?? "openai-response",
    model: payload.model ?? fallbackModel,
    content,
    stop_reason: choice.finish_reason ?? null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0
    }
  };
}

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

  const useOpenAI = isOpenAIModel(model);
  const defaultBase = useOpenAI ? "https://api.openai.com" : "https://api.anthropic.com";
  const rootBase = normalizeBaseUrl(input.aiGatewayBaseUrl || defaultBase);
  const endpoint = useOpenAI ? `${rootBase}/v1/chat/completions` : `${rootBase}/v1/messages`;

  const authToken = input.aiGatewayToken || (useOpenAI ? input.openAiApiKey : input.apiKey);
  if (!authToken) {
    throw new Error(useOpenAI ? "Missing OpenAI or AI Gateway API key/token" : "Missing Anthropic or AI Gateway API key/token");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (input.aiGatewayToken || useOpenAI) {
    headers.authorization = `Bearer ${authToken}`;
  } else {
    headers["x-api-key"] = authToken;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }

  const requestBody = useOpenAI
    ? JSON.stringify({
        model,
        messages: toOpenAIMessages(input.systemPrompt, input.messages),
        tools: toOpenAITools(input.tools),
        max_tokens: 1024
      })
    : JSON.stringify({
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
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: requestBody
    });

    if (response.ok) {
      const payload = (await response.json()) as Record<string, any>;
      return useOpenAI ? toAnthropicLikeResponse(payload, model) : (payload as LLMResponse);
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
