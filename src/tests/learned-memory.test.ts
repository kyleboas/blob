import test from "node:test";
import assert from "node:assert/strict";
import { appendLearnedRecord, flushLearnedRecordsToR2, updateLearnedMemoryStatus, type LearnedRecord } from "../core/memory";
import type { Env } from "../core/types";

class FakeObj {
  constructor(private readonly value: string) {}
  async text(): Promise<string> {
    return this.value;
  }
}

test("learned record appends to sandbox file and flushes to R2", async () => {
  const files = new Map<string, string>();
  const r2 = new Map<string, string>();

  const env = {
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => files.get(path) ?? "",
    },
    REPO_STORE: {
      get: async (key: string) => (r2.has(key) ? (new FakeObj(r2.get(key)!) as unknown as R2ObjectBody) : null),
      put: async (key: string, value: string) => {
        r2.set(key, value);
      },
    },
  } as unknown as Env;

  const record: LearnedRecord = {
    timestamp: "2026-01-01T00:00:00.000Z",
    conversationKey: "T1:C1:channel",
    summary: "User asked for a fix.",
    tags: ["agent-run"],
  };

  await appendLearnedRecord(env, record);
  const result = await flushLearnedRecordsToR2(env, "T1:C1:channel");

  assert.equal(result.count, 1);
  assert.equal(result.lastRecord?.summary, record.summary);
  const key = [...r2.keys()][0];
  assert.match(key, /^memory\/T1:C1:channel\//);
  assert.match(r2.get(key) ?? "", /User asked for a fix/);
});

test("learned memory status is posted to DO", async () => {
  let posted: Record<string, unknown> | null = null;
  const env = {
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ saved: true });
        },
      }),
    },
  } as unknown as Env;

  await updateLearnedMemoryStatus(env, {
    lastFlushAt: "2026-01-01T00:00:00.000Z",
    lastFlushCount: 2,
    lastRecordSummary: "done",
  });

  assert.equal(posted?.lastFlushCount, 2);
  assert.equal(posted?.lastRecordSummary, "done");
});
