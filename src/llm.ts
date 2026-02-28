import {
  LLM_OVERLOAD_RETRY_BASE_MS,
  LLM_OVERLOAD_RETRY_MAX,
  LLM_MAX_TOKENS,
  LLM_MAX_TOKENS_CHAT,
  LLM_MAX_TOKENS_SIMPLE,
  LLM_MAX_TOKENS_COMPLEX,
  LLM_REQUEST_TIMEOUT_MS,
  MODEL_CHAT,
  MODEL_SIMPLE,
  MODEL_COMPLEX
} from "./config";

// Cache tracking for monitoring
interface CacheStats {
  totalCalls: number;
  cacheHits: number;
  cacheMisses: number;
  tokensSaved: number;
}

const cacheStats: CacheStats = {
  totalCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  tokensSaved: 0
};

export function getCacheStats(): CacheStats {
  return { ...cacheStats };
}

export function resetCacheStats(): void {
  cacheStats.totalCalls = 0;
  cacheStats.cacheHits = 0;
  cacheStats.cacheMisses = 0;
  cacheStats.tokensSaved = 0;
}

// Update cache stats from LLM response
function updateCacheStats(response: Record<string, any>): void {
  cacheStats.totalCalls++;

  // Check for Anthropic cache metrics
  const usage = response.usage as Record<string, any> | undefined;
  if (usage) {
    const cacheCreation = usage.cache_creation_input_tokens as number | undefined;
    const cacheRead = usage.cache_read_input_tokens as number | undefined;

    if (cacheRead && cacheRead > 0) {
      cacheStats.cacheHits++;
      cacheStats.tokensSaved += cacheRead;
    } else if (cacheCreation && cacheCreation > 0) {
      cacheStats.cacheMisses++;
    }
  }
}

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

// Simple heuristic for task complexity - no router model needed
function decideTaskComplexity(messages: AnthropicMessage[]): "routine" | "complex" {
  const lastMessage = messages[messages.length - 1];
  const content = typeof lastMessage?.content === "string"
    ? lastMessage.content
    : Array.isArray(lastMessage?.content)
      ? lastMessage.content.map((c) => {
          const block = c as {type?: string; text?: string};
          return block.type === "text" ? block.text : "";
        }).join(" ")
      : "";

  // Complex if: code-related keywords AND long message
  const isCodeRelated = /\b(code|fix|bug|implement|function|class|refactor|test|debug|architecture|design|optimize)\b/i.test(content);
  const isLongTask = content.length > 300;

  return isCodeRelated && isLongTask ? "complex" : "routine";
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
          : decideTaskComplexity(input.messages));
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

      // Update cache stats for tracking
      updateCacheStats(payload);

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

// Extended intent classification with entity extraction
export interface IntentClassificationWithEntities {
  intent: "time_query" | "memory_name_query" | "memory_location_query" | "weather_query" | "set_name" | "set_location" | "set_repo" | "heartbeat_status" | "pause_heartbeats" | "start_heartbeats" | "deployment_status" | "record_deployment" | "merge_staging" | "show_goals" | "set_goals" | "general_chat";
  confidence: number;
  complexity?: "routine" | "complex";
  entities: {
    location?: string;
    name?: string;
    owner?: string;
    repo?: string;
  };
}

// Store for misclassifications to learn from
interface Misclassification {
  text: string;
  predicted: string;
  correct: string;
  timestamp: number;
}

const misclassificationStore: Misclassification[] = [];
const MAX_STORED_EXAMPLES = 20;

// Record a misclassification for learning
export function recordMisclassification(text: string, predicted: string, correct: string): void {
  misclassificationStore.push({
    text,
    predicted,
    correct,
    timestamp: Date.now()
  });
  // Keep only recent examples
  while (misclassificationStore.length > MAX_STORED_EXAMPLES) {
    misclassificationStore.shift();
  }
}

// Get recent misclassifications as few-shot examples
function getLearningExamples(): string {
  if (misclassificationStore.length === 0) return "";

  const examples = misclassificationStore
    .slice(-5) // Last 5 examples
    .map(m => `Text: "${m.text}"\nPreviously classified as: ${m.predicted}\nShould be: ${m.correct}`)
    .join("\n\n");

  return "\n\nLearn from these previous corrections:\n" + examples;
}

// Classify user intent and extract entities using LLM
export async function classifyIntentWithEntities(
  text: string,
  llmCall: (input: CallLLMInput) => Promise<LLMResponse>
): Promise<IntentClassificationWithEntities> {
  const systemPrompt = `You are an intent classifier for Blob, an AI assistant.
Classify the user's message into one of these intents and extract relevant entities:

Intents:
- time_query: Questions about current time ("what time is it", "current time")
- memory_name_query: Asking for user's stored name ("what's my name")
- memory_location_query: Asking for user's stored location ("where do I live", "what's my location")
- weather_query: Weather questions ("what's the weather", "weather in London") - extract location
- set_name: Setting user's name ("my name is John", "call me Jane") - extract name
- set_location: Setting user's location ("my location is Paris", "I live in Tokyo") - extract location
- set_repo: Setting default repository ("my repo is owner/repo") - extract owner and repo
- heartbeat_status: Checking heartbeat status ("are heartbeats on/enabled", "show heartbeats", "heartbeat status", "are heartbeats working")
- pause_heartbeats: Pausing heartbeats ("pause heartbeats", "stop heartbeats")
- start_heartbeats: Starting heartbeats ("start heartbeats", "resume heartbeats")
- deployment_status: Checking deployment status
- record_deployment: Recording a deployment ("just deployed", "deployed to production")
- merge_staging: Merging staging to production ("merge staging to production")
- general_chat: General conversation or unclear intent

Also classify the complexity for execution tasks:
- routine: ONLY simple queries that need no reasoning (time, weather, memory lookups)
- complex: Everything else including code changes, analysis, reasoning, planning, debugging, refactoring, bug fixes, multi-step operations, architecture decisions, explanations, and any task requiring thought

DEFAULT TO COMPLEX unless the task is a trivial lookup. The user wants thorough, well-reasoned solutions.

Respond with ONLY a JSON object:
{"intent": "intent_name", "confidence": 0.95, "complexity": "complex", "entities": {"location": "London", "name": "", "owner": "", "repo": ""}}

Include only relevant entities. Use empty strings for missing entities. No markdown, just JSON.` + getLearningExamples();

  try {
    const response = await llmCall({
      systemPrompt,
      messages: [{ role: "user", content: text }],
      taskComplexityHint: "routine"
    });

    const content = extractTextContent(response);
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as IntentClassificationWithEntities;
      if (parsed.intent && typeof parsed.confidence === "number") {
        return parsed;
      }
    }
  } catch {
    // Fall through to default
  }

  return { intent: "general_chat", confidence: 0, entities: {} };
}

// Task complexity classification result
export interface ComplexityClassification {
  complexity: "routine" | "complex";
  confidence: number;
  reasoning?: string;
}

// Classify task complexity using LLM with structured output
export async function classifyTaskComplexity(
  task: string,
  llmCall: (input: CallLLMInput) => Promise<LLMResponse>
): Promise<ComplexityClassification> {
  const systemPrompt = `You are a task complexity classifier for Blob, an AI coding assistant.

Analyze the task and classify it as either "routine" or "complex":

ROUTINE tasks:
- Simple file reads/writes
- Running basic commands (ls, cat, grep)
- Simple text edits
- Status checks
- Weather lookups
- Memory queries

COMPLEX tasks:
- Code refactoring across multiple files
- Bug fixes requiring analysis
- Implementing new features
- Architecture changes
- Multi-step operations
- Tasks requiring reasoning about code structure

Respond with ONLY a JSON object:
{"complexity": "routine" or "complex", "confidence": 0.95, "reasoning": "brief explanation"}

No markdown, just JSON.`;

  try {
    const response = await llmCall({
      systemPrompt,
      messages: [{ role: "user", content: `Task: ${task}` }],
      taskComplexityHint: "routine"
    });

    const content = extractTextContent(response);
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ComplexityClassification;
      if (parsed.complexity && typeof parsed.confidence === "number") {
        return parsed;
      }
    }
  } catch {
    // Fall through to default
  }

  // Default to routine for safety
  return { complexity: "routine", confidence: 0.5 };
}
