import { describe, expect, it, vi } from "vitest";
import { buildGatewayUrl, callLLM, parseModel, selectModel } from "./llm";
import { MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

describe("parseModel", () => {
  it("parses provider/model format", () => {
    expect(parseModel("openai/gpt-4.1-mini")).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
    expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6"
    });
  });

  it("defaults to anthropic when no slash is present", () => {
    expect(parseModel("claude-haiku-4-5")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });
});

describe("buildGatewayUrl", () => {
  it("builds Anthropic gateway URL with /v1/messages endpoint", () => {
    const url = buildGatewayUrl("my-account", "my-gateway", "anthropic");
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/anthropic/v1/messages"
    );
  });

  it("builds OpenAI gateway URL with /v1/chat/completions endpoint", () => {
    const url = buildGatewayUrl("acct123", "gw456", "openai");
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/openai/v1/chat/completions"
    );
  });
});

describe("selectModel", () => {
  it("defaults to routine model", () => {
    const model = selectModel("You are a helpful assistant", [{ role: "user", content: "say hi" }]);
    expect(model).toBe(MODEL_ROUTINE);
  });

  it("escalates to complex model when prompt indicates complex reasoning", () => {
    const model = selectModel("Perform complex reasoning for architecture migration", []);
    expect(model).toBe(MODEL_COMPLEX);
  });

  it("escalates to complex model when hint is complex", () => {
    const model = selectModel("simple", [{ role: "user", content: "hello" }], "complex");
    expect(model).toBe(MODEL_COMPLEX);
  });
});

// ─── OpenAI path ──────────────────────────────────────────────────────────────

describe("callLLM – OpenAI provider", () => {
  const openAISuccessResponse = {
    id: "chatcmpl-1",
    model: "gpt-4.1-mini",
    choices: [
      {
        message: { role: "assistant", content: "Hello!", tool_calls: null },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };

  it("routes to OpenAI gateway URL when gateway is configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => openAISuccessResponse
    });

    await callLLM({
      apiKey: "anthropic-key",
      openaiApiKey: "openai-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      model: "openai/gpt-4.1-mini",
      gatewayAccountId: "acct",
      gatewayId: "gw",
      fetchImpl: mockFetch
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/v1/chat/completions"
    );
    expect((opts as RequestInit).headers).toMatchObject({
      authorization: "Bearer openai-key"
    });
  });

  it("routes to direct OpenAI URL when gateway is not configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => openAISuccessResponse
    });

    await callLLM({
      apiKey: "anthropic-key",
      openaiApiKey: "openai-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      model: "openai/gpt-4.1-mini",
      fetchImpl: mockFetch
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends system prompt as first message in OpenAI format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => openAISuccessResponse
    });

    await callLLM({
      apiKey: "k",
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      model: "openai/gpt-4.1-mini",
      fetchImpl: mockFetch
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.system).toBeUndefined();
  });

  it("converts Anthropic tools to OpenAI function format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => openAISuccessResponse
    });

    await callLLM({
      apiKey: "k",
      systemPrompt: "sys",
      messages: [],
      tools: [{ name: "bash", description: "Run bash", input_schema: { type: "object" } }],
      model: "openai/gpt-4.1-mini",
      fetchImpl: mockFetch
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" }
        }
      }
    ]);
  });

  it("converts OpenAI tool_calls response to Anthropic tool_use format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chatcmpl-2",
        model: "gpt-4.1-mini",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "bash", arguments: '{"command":"ls"}' }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4 }
      })
    });

    const response = await callLLM({
      apiKey: "k",
      systemPrompt: "sys",
      messages: [],
      model: "openai/gpt-4.1-mini",
      fetchImpl: mockFetch
    });

    expect(response.stop_reason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "call_abc", name: "bash", input: { command: "ls" } }
    ]);
    expect(response.usage).toEqual({ input_tokens: 8, output_tokens: 4 });
  });

  it("converts tool result messages to OpenAI tool role format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => openAISuccessResponse
    });

    await callLLM({
      apiKey: "k",
      systemPrompt: "sys",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "text", text: "file.txt" }]
            }
          ]
        }
      ],
      model: "openai/gpt-4.1-mini",
      fetchImpl: mockFetch
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    // First message is system prompt
    const toolResultMsg = body.messages.find(
      (m: Record<string, unknown>) => m.role === "tool"
    );
    expect(toolResultMsg).toEqual({ role: "tool", tool_call_id: "call_1", content: "file.txt" });
  });
});

// ─── Anthropic path ───────────────────────────────────────────────────────────

describe("callLLM – Anthropic provider", () => {
  const anthropicSuccessResponse = {
    id: "msg_1",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 }
  };

  it("routes to Anthropic gateway URL when gateway is configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => anthropicSuccessResponse
    });

    await callLLM({
      apiKey: "anthropic-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      model: "anthropic/claude-sonnet-4-6",
      gatewayAccountId: "acct",
      gatewayId: "gw",
      fetchImpl: mockFetch
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages"
    );
    expect((opts as RequestInit).headers).toMatchObject({ "x-api-key": "anthropic-key" });
  });

  it("falls back to direct Anthropic URL when gateway is not configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => anthropicSuccessResponse
    });

    await callLLM({
      apiKey: "anthropic-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("sends Anthropic-format request body with prompt caching headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => anthropicSuccessResponse
    });

    await callLLM({
      apiKey: "test-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "bash" }],
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-beta": "prompt-caching-2024-07-31"
    });
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      text: async () => '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'
    };
    const successResponse = {
      ok: true,
      json: async () => anthropicSuccessResponse
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(rateLimitResponse)
      .mockResolvedValueOnce(successResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const response = await callLLM({
      apiKey: "test-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch,
      sleepImpl: mockSleep
    });

    expect(response.id).toBe("msg_1");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 10_000);
  });

  it("throws after exhausting all 429 retries", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      text: async () => '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'
    };
    const mockFetch = vi.fn().mockResolvedValue(rateLimitResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      callLLM({
        apiKey: "test-key",
        systemPrompt: "be helpful",
        messages: [{ role: "user", content: "hello" }],
        fetchImpl: mockFetch,
        sleepImpl: mockSleep
      })
    ).rejects.toThrow("LLM API error (429)");

    expect(mockFetch).toHaveBeenCalledTimes(5); // 1 initial + 4 retries
    expect(mockSleep).toHaveBeenCalledTimes(4);
  });

  it("throws immediately on non-retriable API errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request"
    });

    await expect(
      callLLM({
        apiKey: "test-key",
        systemPrompt: "be helpful",
        messages: [{ role: "user", content: "hello" }],
        fetchImpl: mockFetch
      })
    ).rejects.toThrow("LLM API error (400): bad request");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 529 overloaded and succeeds", async () => {
    const overloadedResponse = {
      ok: false,
      status: 529,
      text: async () => '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    };
    const successResponse = {
      ok: true,
      json: async () => ({
        id: "msg_2",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(overloadedResponse)
      .mockResolvedValueOnce(overloadedResponse)
      .mockResolvedValueOnce(successResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const response = await callLLM({
      apiKey: "test-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch,
      sleepImpl: mockSleep
    });

    expect(response.id).toBe("msg_2");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 10_000);
  });

  it("throws after exhausting all 529 retries", async () => {
    const overloadedResponse = {
      ok: false,
      status: 529,
      text: async () => '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    };
    const mockFetch = vi.fn().mockResolvedValue(overloadedResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      callLLM({
        apiKey: "test-key",
        systemPrompt: "be helpful",
        messages: [{ role: "user", content: "hello" }],
        fetchImpl: mockFetch,
        sleepImpl: mockSleep
      })
    ).rejects.toThrow("LLM API error (529)");

    expect(mockFetch).toHaveBeenCalledTimes(5); // 1 initial + 4 retries
    expect(mockSleep).toHaveBeenCalledTimes(4);
  });
});
