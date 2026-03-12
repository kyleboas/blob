import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../core/intent-classifier";

test("classifyIntent preserves externalDataOnly from LLM output", async () => {
  const env = {
    AI: {
      run: async () => ({ response: '{"intent":"chat","needsSandbox":true,"externalDataOnly":true}' }),
    },
  } as any;

  const result = await classifyIntent("Who is the President", env);
  assert.equal(result.intent, "chat");
  assert.equal(result.needsSandbox, true);
  assert.equal(result.externalDataOnly, true);
});

test("classifyIntent defaults externalDataOnly to false when omitted", async () => {
  const env = {
    AI: {
      run: async () => ({ response: '{"intent":"chat","needsSandbox":true}' }),
    },
  } as any;

  const result = await classifyIntent("Who is the President", env);
  assert.equal(result.intent, "chat");
  assert.equal(result.needsSandbox, true);
  assert.equal(result.externalDataOnly, false);
});
