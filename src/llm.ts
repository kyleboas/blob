import {
  LLM_OVERLOAD_RETRY_BASE_MS,
  LLM_OVERLOAD_RETRY_MAX,
  LLM_REQUEST_TIMEOUT_MS,
  MODEL_COMPLEX,
  MODEL_ROUTINE
} from "./config";

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
  routineModel?: string;
  complexModel?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
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

function ensureCompatBaseUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  return base.endsWith("/compat") ? base : `${base}/compat`;
}

function toGatewayModel(model: string): string {
  if (model.includes("/")) {
    return model;
  }

  if (isOpenAIModel(model)) {
    return `openai/${model}`;
  }

  if (/^claude-|^anthropic\./.test(model)) {
    return `anthropic/${model}`;
  }

  return model;
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

function isRetryableLlmStatus(status: number): boolean {
  if (status === 429 || status === 529) {
    return true;
  }

  return status === 408 || (status >= 500 && status <= 504);
}

function isRetryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { name?: string; message?: string };
  if (maybe.name === "AbortError") return true;
  return /network|fetch|timeout|timed out|socket|econnreset|connection/i.test(maybe.message ?? "");
}

function summarizeResponseHeaders(response: Response): string {
  const headerPairs: Array<[label: string, value: string | null]> = [
    ["request-id", response.headers.get("request-id")],
    ["x-request-id", response.headers.get("x-request-id")],
    ["cf-ray", response.headers.get("cf-ray")],
    ["openai-request-id", response.headers.get("openai-request-id")],
    ["anthropic-request-id", response.headers.get("anthropic-request-id")]
  ];

  return headerPairs
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}=${value}`)
    .join(" ");
}

export function selectModel(
  systemPrompt: string,
  messages: AnthropicMessage[],
  taskComplexityHint?: "routine" | "complex",
  routineModel: string = MODEL_ROUTINE,
  complexModel: string = MODEL_COMPLEX
): string {
  if (taskComplexityHint === "complex") {
    return complexModel;
  }

  if (COMPLEXITY_PATTERN.test(systemPrompt)) {
    return complexModel;
  }

  const containsComplexToolIntent = messages.some((msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return /tool|bash|run command|test suite|migration/i.test(content) && /complex|large|deep/i.test(content);
  });

  return containsComplexToolIntent ? complexModel : routineModel;
}

export async function callLLM(input: CallLLMInput): Promise<LLMResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const model = input.model ?? selectModel(input.systemPrompt, input.messages, input.taskComplexityHint, input.routineModel, input.complexModel);

  const viaGateway = Boolean(input.aiGatewayBaseUrl);
  const useOpenAICompat = viaGateway || isOpenAIModel(model);
  const requestTimeoutMs = input.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS;

  const endpoint = viaGateway
    ? `${ensureCompatBaseUrl(input.aiGatewayBaseUrl!)}/chat/completions`
    : (useOpenAICompat ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages");

  const headers: Record<string, string> = { "content-type": "application/json" };

  if (useOpenAICompat) {
    if (viaGateway) {
      if (!input.aiGatewayToken) {
        throw new Error("Missing AI Gateway token");
      }

      headers["cf-aig-authorization"] = `Bearer ${input.aiGatewayToken}`;

      const providerToken = input.openAiApiKey || input.apiKey;
      if (providerToken) {
        headers.authorization = `Bearer ${providerToken}`;
      }
    } else {
      const openAiToken = input.openAiApiKey;
      if (!openAiToken) {
        throw new Error("Missing OpenAI API key");
      }

      headers.authorization = `Bearer ${openAiToken}`;
    }
  } else {
    const anthropicKey = input.apiKey;
    if (!anthropicKey) {
      throw new Error("Missing Anthropic API key");
    }

    headers["x-api-key"] = anthropicKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }

  const resolvedModel = viaGateway ? toGatewayModel(model) : model;
  const requestBody = useOpenAICompat
    ? JSON.stringify({
        model: resolvedModel,
        messages: toOpenAIMessages(input.systemPrompt, input.messages),
        tools: toOpenAITools(input.tools),
        max_tokens: 1024
      })
    : JSON.stringify({
        model: resolvedModel,
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
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException(`LLM request timed out after ${requestTimeoutMs}ms`, "AbortError"));
    }, requestTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: requestBody,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (isRetryableTransportError(error) && attempt < LLM_OVERLOAD_RETRY_MAX) {
        const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
        await sleepImpl(waitMs);
        continue;
      }
      throw error;
    }
    clearTimeout(timeout);

    if (response.ok) {
      const payload = (await response.json()) as Record<string, any>;
      return useOpenAICompat ? toAnthropicLikeResponse(payload, resolvedModel) : (payload as LLMResponse);
    }

    if (isRetryableLlmStatus(response.status) && attempt < LLM_OVERLOAD_RETRY_MAX) {
      const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
      await sleepImpl(waitMs);
      continue;
    }

    const errorText = await response.text();
    const attempts = attempt + 1;
    const attemptText = `attempt ${attempts}/${LLM_OVERLOAD_RETRY_MAX + 1}`;
    const responseHeaders = summarizeResponseHeaders(response);
    const headersText = responseHeaders ? ` [${responseHeaders}]` : "";
    throw new Error(`LLM API error (${response.status}, ${attemptText})${headersText}: ${errorText}`);
  }

  throw new Error("LLM API error: max retries exceeded");
}
