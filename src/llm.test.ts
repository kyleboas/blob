import { describe, expect, it, vi } from "vitest";
import { callLLM, selectModel } from "./llm";
import { MODEL_COMPLEX, MODEL_ROUTINE } from "./config";

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
    expect((options as RequestInit).headers).toMatchObject({ authorization: "Bearer gateway-token" });
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
      model: "openai/gpt-4.1-mini",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: mockFetch
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions");
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.model).toBe("openai/gpt-4.1-mini");
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
});
