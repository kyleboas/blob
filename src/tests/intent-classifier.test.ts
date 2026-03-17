import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../core/intent-classifier";

test("classifyIntent preserves needsSandbox from LLM output", async () => {
  const env = {
    AI: {
      run: async () => ({ response: '{"intent":"chat","needsSandbox":true}' }),
    },
  } as any;

  const result = await classifyIntent("Who is the President", env);
  assert.equal(result.intent, "chat");
  assert.equal(result.needsSandbox, true);
});

test("classifyIntent falls back to sandbox-required chat when classification fails", async () => {
  const env = {
    AI: {
      run: async () => {
        throw new Error("boom");
      },
    },
  } as any;

  const result = await classifyIntent("Who is the President", env);
  assert.equal(result.intent, "chat");
  assert.equal(result.needsSandbox, true);
});
