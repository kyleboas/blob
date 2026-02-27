import {
  LLM_OVERLOAD_RETRY_BASE_MS,
  LLM_OVERLOAD_RETRY_MAX,
  LLM_MAX_TOKENS,
  LLM_MAX_TOKENS_CHAT,
  LLM_MAX_TOKENS_SIMPLE,
  LLM_MAX_TOKENS_COMPLEX,
  LLM_REQUEST_TIMEOUT_MS,
  MODEL_ROUTER,
  MODEL_CHAT,
  MODEL_SIMPLE,
  MODEL_COMPLEX
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
  routerModel?: string;
  chatModel?: string;
  simpleModel?: string;
  complexModel?: string;
  // Backwards-compatible aliases
  routineModel?: string;
  model?: string;
  maxTokens?: number;
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

function isOpenAIModel(model: string): boolean {
  return /^gpt-|^o[1-9]|^o\d|^openai\//.test(model);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function toCompatChatCompletionsUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  if (base.endsWith("/compat/chat/completions")) return base;
  if (base.endsWith("/compat")) return `${base}/chat/completions`;
  return `${base}/compat/chat/completions`;
}

function asBearer(token: string): string {
  const trimmed = token.trim();
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function toGatewayModel(model: string): string {
  if (model.startsWith("@cf/")) {
    return `workers-ai/${model}`;
  }

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
        openAiMessages.push({ role: "assistant", content: textContent, tool_calls: toolCalls });
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
  if (payload.error) {
    const code = payload.error.code ?? payload.error.status ?? "unknown";
    const msg = payload.error.message ?? JSON.stringify(payload.error);
    throw new Error(`LLM gateway error (${code}): ${msg}`);
  }

  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};

  if (choice.finish_reason === "length") {
    throw new Error("LLM response truncated: model hit max_tokens limit before producing output");
  }

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
  _systemPrompt: string,
  _messages: AnthropicMessage[],
  taskComplexityHint?: "routine" | "complex",
  simpleModel: string = MODEL_SIMPLE,
  complexModel: string = MODEL_COMPLEX
): string {
  if (taskComplexityHint === "complex") {
    return complexModel;
  }

  return simpleModel;
}

async function decideTaskComplexityWithModel(input: {
  fetchImpl: typeof fetch;
  apiKey?: string;
  openAiApiKey?: string;
  aiGatewayToken?: string;
  aiGatewayBaseUrl?: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  routerModel: string;
}): Promise<"routine" | "complex"> {
  const viaGateway = Boolean(input.aiGatewayBaseUrl);
  const useOpenAICompat = viaGateway || isOpenAIModel(input.routerModel);

  const endpoint = viaGateway
    ? toCompatChatCompletionsUrl(input.aiGatewayBaseUrl!)
    : (useOpenAICompat ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages");

  const headers: Record<string, string> = { "content-type": "application/json" };

  if (useOpenAICompat) {
    if (viaGateway) {
      if (!input.aiGatewayToken) {
        return "routine";
      }

      headers["cf-aig-authorization"] = asBearer(input.aiGatewayToken);
      const providerToken = (input.openAiApiKey || input.apiKey || "").trim();
      if (providerToken) {
        headers.authorization = asBearer(providerToken);
      }
    } else {
      if (!input.openAiApiKey) {
        return "routine";
      }
      headers.authorization = `Bearer ${input.openAiApiKey}`;
    }
  } else {
    if (!input.apiKey) {
      return "routine";
    }

    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  const routingPrompt = [
    "Classify the task complexity for model routing.",
    "Respond with JSON only using this schema: {\"complexity\":\"routine\"|\"complex\"}.",
    "Choose complex only for deep multi-step reasoning, large refactors, or architecture-level decisions."
  ].join(" ");

  const lastUserMessage = [...input.messages].reverse().find((m) => m.role === "user");
  const routingPayload = typeof lastUserMessage?.content === "string"
    ? lastUserMessage.content
    : JSON.stringify(lastUserMessage?.content ?? "");

  const body = useOpenAICompat
    ? JSON.stringify({
        model: viaGateway ? toGatewayModel(input.routerModel) : input.routerModel,
        messages: [
          { role: "system", content: routingPrompt },
          { role: "user", content: routingPayload }
        ],
        max_tokens: 16,
        temperature: 0
      })
    : JSON.stringify({
        model: input.routerModel,
        max_tokens: 16,
        system: routingPrompt,
        messages: [{ role: "user", content: routingPayload }]
      });

  try {
    const response = await input.fetchImpl(endpoint, { method: "POST", headers, body });
    if (!response.ok) {
      return "routine";
    }

    const payload = await response.json() as Record<string, any>;
    const decisionText = useOpenAICompat
      ? String(payload.choices?.[0]?.message?.content ?? "")
      : String((payload.content ?? []).map((block: { text?: string }) => block.text ?? "").join(" "));
    return parseComplexityDecision(decisionText);
  } catch {
    return "routine";
  }
}

function parseComplexityDecision(decisionText: string): "routine" | "complex" {
  const normalized = decisionText.trim().toLowerCase();

  if (normalized === "routine" || normalized === "complex") {
    return normalized;
  }

  try {
    const parsed = JSON.parse(decisionText) as { complexity?: unknown };
    return parsed.complexity === "complex" ? "complex" : "routine";
  } catch {
    return "routine";
  }
}

function parseMessageType(decisionText: string): "chat" | "routine" | "complex" {
  const normalized = decisionText.trim().toLowerCase();

  if (normalized === "chat" || normalized === "routine" || normalized === "complex") {
    return normalized as "chat" | "routine" | "complex";
  }

  try {
    const parsed = JSON.parse(decisionText) as { type?: unknown };
    if (parsed.type === "chat") return "chat";
    if (parsed.type === "complex") return "complex";
    return "routine";
  } catch {
    return "routine";
  }
}


/**
 * Uses the router model to classify an incoming message as "chat" (conversational,
 * no task execution needed), "routine" (straightforward coding/automation task), or
 * "complex" (deep multi-step reasoning, large refactor, architecture-level work).
 *
 * Falls back to "routine" on any error so the caller always gets a task routed
 * to a capable model rather than silently dropped.
 */
export async function classifyMessage(input: {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  openAiApiKey?: string;
  aiGatewayToken?: string;
  aiGatewayBaseUrl?: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  routerModel: string;
}): Promise<"chat" | "routine" | "complex"> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const viaGateway = Boolean(input.aiGatewayBaseUrl);
  const useOpenAICompat = viaGateway || isOpenAIModel(input.routerModel);

  const endpoint = viaGateway
    ? toCompatChatCompletionsUrl(input.aiGatewayBaseUrl!)
    : (useOpenAICompat ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages");

  const headers: Record<string, string> = { "content-type": "application/json" };

  if (useOpenAICompat) {
    if (viaGateway) {
      if (!input.aiGatewayToken) {
        return "routine";
      }
      headers["cf-aig-authorization"] = asBearer(input.aiGatewayToken);
      const providerToken = (input.openAiApiKey || input.apiKey || "").trim();
      if (providerToken) {
        headers.authorization = asBearer(providerToken);
      }
    } else {
      if (!input.openAiApiKey) {
        return "routine";
      }
      headers.authorization = `Bearer ${input.openAiApiKey}`;
    }
  } else {
    if (!input.apiKey) {
      return "routine";
    }
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  const routingPrompt = [
    "Classify the message type for model routing.",
    'Respond with JSON only using this schema: {"type":"chat"|"routine"|"complex"}.',
    'Use "chat" ONLY when the user is purely conversational (greetings, small talk, opinions) and is NOT asking Blob to perform work or provide information from its systems.',
    'Use "routine" for:',
    '  - Actionable execution requests (create PR, run tests, deploy)',
    '  - Status queries ("show my heartbeats", "what are my goals", "deployment status")',
    '  - Capability checks ("can you create a pull request", "test if you can")',
    '  - ANY request that requires checking Blob\'s internal state or databases',
    'Use "complex" for architecture-level decisions, deep multi-step planning, or large refactors.'
  ].join(" ");

  const lastUserMessage = [...input.messages].reverse().find((m) => m.role === "user");
  const routingPayload = typeof lastUserMessage?.content === "string"
    ? lastUserMessage.content
    : JSON.stringify(lastUserMessage?.content ?? "");


  const body = useOpenAICompat
    ? JSON.stringify({
        model: viaGateway ? toGatewayModel(input.routerModel) : input.routerModel,
        messages: [
          { role: "system", content: routingPrompt },
          { role: "user", content: routingPayload }
        ],
        max_tokens: 16,
        temperature: 0
      })
    : JSON.stringify({
        model: input.routerModel,
        max_tokens: 16,
        system: routingPrompt,
        messages: [{ role: "user", content: routingPayload }]
      });

  try {
    const response = await fetchImpl(endpoint, { method: "POST", headers, body });
    if (!response.ok) {
      return "routine";
    }
    const payload = await response.json() as Record<string, any>;
    const decisionText = useOpenAICompat
      ? String(payload.choices?.[0]?.message?.content ?? "")
      : String((payload.content ?? []).map((block: { text?: string }) => block.text ?? "").join(" "));
    return parseMessageType(decisionText);
  } catch {
    return "routine";
  }
}

function getModelSpecificMaxTokens(model: string, hint?: "chat" | "routine" | "complex"): number {
  // Use hint if provided, otherwise infer from model name
  if (hint === "chat") return LLM_MAX_TOKENS_CHAT;
  if (hint === "complex") return LLM_MAX_TOKENS_COMPLEX;
  if (hint === "routine") return LLM_MAX_TOKENS_SIMPLE;
  
  // Infer from model name
  if (model.includes("claude")) return LLM_MAX_TOKENS_COMPLEX;
  if (model.includes("glm") || model.includes("chat")) return LLM_MAX_TOKENS_CHAT;
  return LLM_MAX_TOKENS_SIMPLE;
}

export async function callLLM(input: CallLLMInput): Promise<LLMResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const routerModel = input.routerModel ?? input.routineModel ?? MODEL_ROUTER;
  const chatModel = input.chatModel ?? MODEL_CHAT;
  const simpleModel = input.simpleModel ?? input.routineModel ?? MODEL_SIMPLE;
  const complexModel = input.complexModel ?? MODEL_COMPLEX;

  let model = input.model;
  let modelHint: "chat" | "routine" | "complex" | undefined;
  
  if (!model) {
    const isChatTurn = !input.tools?.length && !input.taskComplexityHint;
    if (isChatTurn) {
      model = chatModel;
      modelHint = "chat";
    } else {
      const taskComplexityHint = input.taskComplexityHint
        ?? (simpleModel === complexModel
          ? "routine"
          : await decideTaskComplexityWithModel({
              fetchImpl,
              apiKey: input.apiKey,
              openAiApiKey: input.openAiApiKey,
              aiGatewayToken: input.aiGatewayToken,
              aiGatewayBaseUrl: input.aiGatewayBaseUrl,
              systemPrompt: input.systemPrompt,
              messages: input.messages,
              routerModel
            }));
      model = selectModel(input.systemPrompt, input.messages, taskComplexityHint, simpleModel, complexModel);
      modelHint = taskComplexityHint === "complex" ? "complex" : "routine";
    }
  }
  
  // Use model-specific max tokens, with override if provided
  const maxTokens = input.maxTokens ?? getModelSpecificMaxTokens(model, modelHint);

  const viaGateway = Boolean(input.aiGatewayBaseUrl);
  const useOpenAICompat = viaGateway || isOpenAIModel(model);
  const requestTimeoutMs = input.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS;

  const endpoint = viaGateway
    ? toCompatChatCompletionsUrl(input.aiGatewayBaseUrl!)
    : (useOpenAICompat ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages");

  const headers: Record<string, string> = { "content-type": "application/json" };

  if (useOpenAICompat) {
    if (viaGateway) {
      if (!input.aiGatewayToken) {
        throw new Error("Missing AI Gateway token");
      }
      headers["cf-aig-authorization"] = asBearer(input.aiGatewayToken);

      const providerToken = (input.openAiApiKey || input.apiKey || "").trim();
      if (providerToken) {
        headers.authorization = asBearer(providerToken);
      } else {
        delete headers.authorization;
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
        max_tokens: maxTokens
      })
    : JSON.stringify({
        model: resolvedModel,
        max_tokens: maxTokens,
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
      if (useOpenAICompat) {
        // Cloudflare Workers AI tool-calling bug: the gateway occasionally returns
        // finish_reason="stop" with content=null and no tool_calls when the model
        // intended to call a tool. Retry these as transient failures when tools
        // were included in the request.
        const choice = (payload.choices as Array<Record<string, any>> | undefined)?.[0] ?? {};
        const message = (choice.message ?? {}) as Record<string, any>;
        const isNullContentStop =
          choice.finish_reason === "stop" &&
          message.content === null &&
          (!message.tool_calls || (message.tool_calls as unknown[]).length === 0) &&
          (input.tools?.length ?? 0) > 0;
        if (isNullContentStop && attempt < LLM_OVERLOAD_RETRY_MAX) {
          const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
          await sleepImpl(waitMs);
          continue;
        }
        return toAnthropicLikeResponse(payload, resolvedModel);
      }
      return payload as LLMResponse;
    }

    if (isRetryableLlmStatus(response.status) && attempt < LLM_OVERLOAD_RETRY_MAX) {
      const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
      await sleepImpl(waitMs);
      continue;
    }

    const errorText = await response.text();

    // If an OpenAI-compat provider returns a completion-shaped payload with a non-2xx
    // status (seen with Workers AI), try to recover instead of hard-failing.
    if (useOpenAICompat) {
      try {
        const payload = JSON.parse(errorText) as Record<string, any>;
        if (!payload?.error && Array.isArray(payload.choices)) {
          const choice = payload.choices?.[0] ?? {};
          const message = choice.message ?? {};

          const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
          const hasText = typeof message.content === "string" && message.content.trim().length > 0;

          const isNullContentStop =
            choice.finish_reason === "stop" &&
            message.content === null &&
            !hasToolCalls;

          // Retry the known "null content stop" glitch even if it came back as HTTP 400.
          if (isNullContentStop && attempt < LLM_OVERLOAD_RETRY_MAX) {
            const waitMs = LLM_OVERLOAD_RETRY_BASE_MS * Math.pow(2, attempt);
            await sleepImpl(waitMs);
            continue;
          }

          // If it looks like a real completion (text or tool calls), accept it despite the status.
          if (hasText || hasToolCalls || isNullContentStop) {
            return toAnthropicLikeResponse(payload, resolvedModel);
          }
        }
      } catch {
        // fall through to normal error handling
      }
    }

    const attempts = attempt + 1;
    const attemptText = `attempt ${attempts}/${LLM_OVERLOAD_RETRY_MAX + 1}`;
    const responseHeaders = summarizeResponseHeaders(response);
    const headersText = responseHeaders ? ` [${responseHeaders}]` : "";
    throw new Error(`LLM API error (${response.status}, ${attemptText})${headersText}: ${errorText}`);
  }

  throw new Error("LLM API error: max retries exceeded");
}

// Extract text content from LLM response
export function extractTextContent(response: LLMResponse): string {
  return (response.content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

// Intent classification result
export interface IntentClassification {
  intent: "heartbeat_status" | "pause_heartbeats" | "start_heartbeats" | "deployment_status" | "record_deployment" | "merge_staging" | "set_repo" | "show_goals" | "set_goals" | "general_chat";
  confidence: number;
  entities?: Record<string, string>;
}

// Classify user intent using LLM
export async function classifyIntent(
  text: string,
  llmCall: (input: CallLLMInput) => Promise<LLMResponse>
): Promise<IntentClassification> {
  const systemPrompt = `You are an intent classifier for Blob, an AI assistant.
Classify the user's message into one of these intents:
- heartbeat_status: Questions about heartbeat status ("are heartbeats on", "show heartbeats", "heartbeat working")
- pause_heartbeats: Request to pause/stop heartbeats
- start_heartbeats: Request to start/resume heartbeats  
- deployment_status: Questions about deployment status
- record_deployment: User saying they just deployed
- merge_staging: Request to merge staging to production
- set_repo: Setting default repository ("my repo is owner/repo")
- show_goals: Showing repository goals
- set_goals: Setting repository goals
- general_chat: General conversation or unclear intent

Respond with ONLY a JSON object in this exact format:
{"intent": "intent_name", "confidence": 0.95}

No other text, no markdown, just the JSON.`;

  try {
    const response = await llmCall({
      systemPrompt,
      messages: [{ role: "user", content: text }],
      taskComplexityHint: "routine"
    });

    const content = extractTextContent(response);
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as IntentClassification;
      if (parsed.intent && typeof parsed.confidence === "number") {
        return parsed;
      }
    }
  } catch {
    // Fall through to default
  }

  return { intent: "general_chat", confidence: 0 };
}
