import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanticMemoryContext,
  querySemanticMemory,
  upsertSemanticMemory,
  type LearnedRecord,
} from "../core/memory-system";
import type { Env } from "../core/types";

function makeEnv() {
  const upserts: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const env = {
    AI: {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    },
    PI_VECTORS: {
      upsert: async (vectors: Array<{ id: string; metadata?: Record<string, unknown> }>) => {
        upserts.push({ id: vectors[0].id, metadata: vectors[0].metadata ?? {} });
      },
      query: async () => ({
        matches: [
          {
            id: "conv:T1:C1:1",
            score: 0.9,
            metadata: {
              conversationKey: "T1:C1",
              r2Key: "memory/T1/C1/learned.jsonl",
              snippet: "remember this",
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
      }),
    },
    REPO_STORE: {
      get: async () => null,
    },
  } as unknown as Env;

  return { env, upserts };
}

test("upsertSemanticMemory stores metadata references in vectorize", async () => {
  const { env, upserts } = makeEnv();
  const record: LearnedRecord = {
    timestamp: "2026-01-01T00:00:00.000Z",
    conversationKey: "T1:C1",
    summary: "User prefers concise output",
    tags: ["preference"],
  };

  const result = await upsertSemanticMemory(env, {
    conversationKey: "T1:C1",
    record,
    r2Key: "memory/T1/C1/learned.jsonl",
  });

  assert.equal(result.ok, true);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].metadata.r2Key, "memory/T1/C1/learned.jsonl");
  assert.equal(typeof upserts[0].metadata.snippet, "string");
});

test("querySemanticMemory returns mapped matches", async () => {
  const { env } = makeEnv();
  const matches = await querySemanticMemory(env, {
    conversationKey: "T1:C1",
    query: "what output style do I prefer?",
    topK: 5,
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].r2Key, "memory/T1/C1/learned.jsonl");
  assert.equal(matches[0].snippet, "remember this");
});

test("buildSemanticMemoryContext enforces max char cap", async () => {
  const { env } = makeEnv();
  const context = await buildSemanticMemoryContext(env, [
    { id: "1", score: 0.9, snippet: "first item" },
    { id: "2", score: 0.8, snippet: "second item" },
  ], 20);

  assert.match(context, /Relevant learned memory/);
  assert.match(context, /first item/);
  assert.doesNotMatch(context, /second item/);
});
