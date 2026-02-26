import { describe, expect, it, vi } from "vitest";
import { callLLM, selectModel } from "./llm";
import { MODEL_CHAT, MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

describe("selectModel", () => {
  it("defaults to routine model", () => {
    const model = selectModel("You are a helpful assistant", [{ role: "user", content: "say hi" }]);
    expect(model).toBe(MODEL_ROUTINE);
  });

  it("stays on routine model when no complexity hint is provided", () => {
    const model = selectModel("Perform complex reasoning for architecture migration", []);
    expect(model).toBe(MODEL_ROUTINE);
  });

  it("escalates to complex model when hint is complex", () => {
    const model = selectModel("simple", [{ role: "user", content: "hello" }], "complex");
    expect(model).toBe(MODEL_COMPLEX);
  });

  it("uses provided routine/complex model overrides", () => {
    const model = selectModel(
      "simple",
      [{ role: "user", content: "hello" }],
      undefined,
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4-6"
    );
    expect(model).toBe("openai/gpt-4.1-mini");
  });

  it("uses routine override when no complexity hint is provided", () => {
    const model = selectModel(
      "complex-looking prompt",
      [{ role: "user", content: "please do many steps" }],
      undefined,
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4-6"
    );
    expect(model).toBe("openai/gpt-4.1-mini");
  });
});

describe("callLLM", () => {
  it("forms Anthropic request by default", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_1",
        model: MODEL_ROUTINE,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    });

    await callLLM({
      apiKey: "anthropic-key",
      model: "claude-sonnet-4-6",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((options as RequestInit).headers).toMatchObject({
      "x-api-key": "anthropic-key",
      "anthropic-beta": "prompt-caching-2024-07-31"
    });
  });

  it("uses OpenAI-compatible endpoint and normalizes tool calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chatcmpl_1",
        model: "gpt-4.1-mini",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Working on it",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "bash", arguments: '{"command":"ls"}' }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4 }
      })
    });

    const response = await callLLM({
      openAiApiKey: "openai-key",
      model: "gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "bash", description: "run commands", input_schema: { type: "object", properties: {} } }],
      fetchImpl: mockFetch
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((options as RequestInit).headers).toMatchObject({ authorization: "Bearer openai-key" });
    expect(response.content).toEqual([
      { type: "text", text: "Working on it" },
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }
    ]);
  });

  it("routes through Cloudflare AI Gateway unified compat endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1", model: "claude-sonnet-4-6", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } })
    });

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      model: "claude-sonnet-4-6",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions");
    expect((options as RequestInit).headers).toMatchObject({
      "cf-aig-authorization": "Bearer gateway-token"
    });
    expect((options as RequestInit).headers).not.toHaveProperty("authorization");
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses pre-configured compat base URL without appending twice", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1", model: "openai/gpt-4.1-mini", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    });

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat",
      aiGatewayToken: "gateway-token",
      openAiApiKey: "openai-key",
      model: "openai/gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions");
    expect((options as RequestInit).headers).toMatchObject({
      "cf-aig-authorization": "Bearer gateway-token",
      authorization: "Bearer openai-key"
    });
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.model).toBe("openai/gpt-4.1-mini");
  });


  it("uses full compat chat completions URL without appending twice", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1", model: "openai/gpt-4.1-mini", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    });

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions",
      aiGatewayToken: "gateway-token",
      model: "openai/gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions");
  });

  it("allows gateway requests without provider key for unified billing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1", model: "openai/gpt-4.1-mini", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    });

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      model: "openai/gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({
      "cf-aig-authorization": "Bearer gateway-token"
    });
    expect((options as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const rateLimitResponse = { ok: false, status: 429, text: async () => "rate limit" };
    const successResponse = {
      ok: true,
      json: async () => ({ id: "msg_3", model: MODEL_ROUTINE, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
    };
    const mockFetch = vi.fn().mockResolvedValueOnce(rateLimitResponse).mockResolvedValueOnce(successResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    await callLLM({
      openAiApiKey: "openai-key",
      model: "gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch,
      sleepImpl: mockSleep
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(5_000);
  });

  it("retries on 500 upstream failures and succeeds", async () => {
    const upstreamErrorResponse = { ok: false, status: 500, text: async () => "internal server error" };
    const successResponse = {
      ok: true,
      json: async () => ({ id: "msg_4", model: MODEL_ROUTINE, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
    };
    const mockFetch = vi.fn().mockResolvedValueOnce(upstreamErrorResponse).mockResolvedValueOnce(successResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      apiKey: "anthropic-key",
      model: "claude-sonnet-4-6",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch,
      sleepImpl: mockSleep
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(5_000);
  });

  it("retries on transport timeout errors and succeeds", async () => {
    const timeoutError = new Error("request timed out while waiting for upstream");
    timeoutError.name = "AbortError";
    const successResponse = {
      ok: true,
      json: async () => ({ id: "msg_5", model: MODEL_ROUTINE, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
    };
    const mockFetch = vi.fn().mockRejectedValueOnce(timeoutError).mockResolvedValueOnce(successResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      model: "claude-sonnet-4-6",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch,
      sleepImpl: mockSleep
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(5_000);
  });

  it("passes an abort signal to fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "msg_6", model: MODEL_ROUTINE, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
    });

    await callLLM({
      openAiApiKey: "openai-key",
      model: "gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      requestTimeoutMs: 12345,
      fetchImpl: mockFetch
    });

    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("includes attempt count and request identifiers in API errors", async () => {
    const failedResponse = {
      ok: false,
      status: 500,
      headers: new Headers({
        "cf-ray": "trace-123",
        "request-id": "req-abc"
      }),
      text: async () => '{"error":"internal server error"}'
    };
    const mockFetch = vi.fn().mockResolvedValue(failedResponse);

    await expect(callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      model: "claude-sonnet-4-6",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch,
      sleepImpl: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow("LLM API error (500, attempt 5/5) [request-id=req-abc cf-ray=trace-123]: {\"error\":\"internal server error\"}");
  });


  it("uses chat model for top-layer chat turns", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_chat",
        model: MODEL_CHAT,
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 }
      })
    });

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      openAiApiKey: "openai-key",
      chatModel: MODEL_CHAT,
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body.model).toBe(`workers-ai/${MODEL_CHAT}`);
  });

  it("asks the router model to choose complexity when tools are present and model is not provided", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "route_1",
          choices: [{ message: { content: '{"complexity":"complex"}' } }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "msg_7",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 3 }
        })
      });

    await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      openAiApiKey: "openai-key",
      routerModel: "@cf/ibm-granite/granite-4.0-h-micro",
      simpleModel: "@cf/qwen/qwen2.5-coder-32b-instruct",
      complexModel: "anthropic/claude-sonnet-4-6",
      tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: {} } }],
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "plan a migration" }],
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const routingBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(routingBody.model).toBe("workers-ai/@cf/ibm-granite/granite-4.0-h-micro");
    expect(routingBody.messages[0].content).toContain("Respond with JSON only");

    const generationBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(generationBody.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("retries Cloudflare Workers AI tool-calling bug (finish_reason=stop, content=null, no tool_calls)", async () => {
    const buggyResponse = {
      ok: true,
      json: async () => ({
        id: "cf_bug_1",
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
        choices: [{ finish_reason: "stop", message: { content: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 0 }
      })
    };
    const goodResponse = {
      ok: true,
      json: async () => ({
        id: "cf_good_1",
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      })
    };
    const mockFetch = vi.fn().mockResolvedValueOnce(buggyResponse).mockResolvedValueOnce(goodResponse);
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const response = await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "run ls" }],
      tools: [{ name: "bash", description: "run commands", input_schema: { type: "object", properties: {} } }],
      fetchImpl: mockFetch,
      sleepImpl: mockSleep
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(response.content).toEqual([
      { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }
    ]);
  });

  it("does not retry Cloudflare finish_reason=stop with null content when no tools were sent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "cf_chat_1",
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
        choices: [{ finish_reason: "stop", message: { content: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 0 }
      })
    });

    const response = await callLLM({
      aiGatewayBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway",
      aiGatewayToken: "gateway-token",
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(response.content).toEqual([{ type: "text", text: "" }]);
  });

  it("skips routing call when simple and complex models are the same", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_same",
        model: "openai/gpt-4.1-mini",
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      })
    });

    await callLLM({
      openAiApiKey: "openai-key",
      model: "openai/gpt-4.1-mini",
      simpleModel: "openai/gpt-4.1-mini",
      complexModel: "openai/gpt-4.1-mini",
      tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: {} } }],
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

});
