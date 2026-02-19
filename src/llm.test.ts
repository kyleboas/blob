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

  it("throws on rate limit/API error responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limit"
    });

    await expect(
      callLLM({
        apiKey: "test-key",
        systemPrompt: "be helpful",
        messages: [{ role: "user", content: "hello" }],
        fetchImpl: mockFetch
      })
    ).rejects.toThrow("Anthropic API error (429): rate limit");
  });
});
