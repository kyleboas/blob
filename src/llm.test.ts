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
});

describe("callLLM", () => {
  it("forms the API request and parses response", async () => {
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

    const response = await callLLM({
      apiKey: "test-key",
      systemPrompt: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "bash" }],
      fetchImpl: mockFetch
    });

    expect(response.id).toBe("msg_1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-beta": "prompt-caching-2024-07-31"
    });
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      text: async () => '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'
    };
    const successResponse = {
      ok: true,
      json: async () => ({
        id: "msg_3",
        model: MODEL_ROUTINE,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    };
    const mockFetch = vi.fn()
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

    expect(response.id).toBe("msg_3");
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
    ).rejects.toThrow("Anthropic API error (429)");

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
    ).rejects.toThrow("Anthropic API error (400): bad request");

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
        model: MODEL_ROUTINE,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    };
    const mockFetch = vi.fn()
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
    ).rejects.toThrow("Anthropic API error (529)");

    expect(mockFetch).toHaveBeenCalledTimes(5); // 1 initial + 4 retries
    expect(mockSleep).toHaveBeenCalledTimes(4);
  });
});
