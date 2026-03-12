import test from "node:test";
import assert from "node:assert/strict";
import {
  R2MemoryStore,
  applyRetention,
  appendDailyLearned,
  compactScope,
  embedText,
  flushLearnedBeforeCompaction,
  parseLearnedJsonl,
  recallMemory,
  redactSecrets,
  reconcileMemory,
  validateIngestion,
  writeMemoryItem,
} from "../core/memory-system";
import type { Env } from "../core/types";

class FakeR2Object {
  constructor(private readonly value: string) {}
  async json(): Promise<unknown> {
    return JSON.parse(this.value);
  }
  async text(): Promise<string> {
    return this.value;
  }
}

class FakeR2Bucket {
  private readonly data = new Map<string, string>();
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async get(key: string): Promise<FakeR2Object | null> {
    const value = this.data.get(key);
    return value ? new FakeR2Object(value) : null;
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list({ prefix }: { prefix: string }): Promise<{ objects: Array<{ key: string }> }> {
    const objects = [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
    return { objects };
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const bucket = (overrides.REPO_STORE as unknown as R2Bucket) ?? (new FakeR2Bucket() as unknown as R2Bucket);
  return {
    AGENT_DO: {} as DurableObjectNamespace,
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async () => undefined,
      readFile: async () => "",
    },
    REPO_STORE: bucket,
    ...overrides,
  } as Env;
}

test("validateIngestion rejects secrets and oversized payloads", async () => {
  const env = makeEnv();
  assert.deepEqual(await validateIngestion(env, "team", "password=supersecret123"), { valid: false, reason: "secret_detected" });
  assert.deepEqual(await validateIngestion(env, "team", "x ".repeat(2200)), { valid: false, reason: "oversized" });
});

test("writeMemoryItem marks unindexed when vector upsert fails", async () => {
  const bucket = new FakeR2Bucket();
  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    PI_VECTORS: {
      upsert: async () => {
        throw new Error("boom");
      },
      query: async () => ({ count: 0, matches: [] }),
      deleteByIds: async () => undefined,
      insert: async () => undefined,
      getByIds: async () => ({ vectors: [] }),
      describe: async () => ({ dimensions: 2, count: 0, metric: "cosine" }),
    } as unknown as VectorizeIndex,
  });
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);
  const item = await writeMemoryItem(env, store, { scope: "thread", content: "remember this", source: "thread" });
  assert.equal(item.unindexed, true);
});

test("recallMemory respects scope priority and deduplicates by content hash", async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);
  const a = await store.create({ id: "a", scope: "thread", content: "same", source: "thread" });
  const b = await store.create({ id: "b", scope: "channel", content: "same", source: "thread" });
  const c = await store.create({ id: "c", scope: "team", content: "different", source: "thread" });

  const env = makeEnv({
    PI_VECTORS: {
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
      query: async (_vec: number[], opts?: VectorizeQueryOptions) => {
        const scope = String(opts?.filter && "scope" in opts.filter ? opts.filter.scope : "");
        if (scope === "thread") return { count: 1, matches: [{ id: a.id, score: 0.99 }] };
        if (scope === "channel") return { count: 1, matches: [{ id: b.id, score: 0.98 }] };
        return { count: 1, matches: [{ id: c.id, score: 0.97 }] };
      },
      insert: async () => undefined,
      getByIds: async () => ({ vectors: [] }),
      describe: async () => ({ dimensions: 2, count: 3, metric: "cosine" }),
    } as unknown as VectorizeIndex,
    AI: { run: async () => ({ data: [[0.3, 0.4]] }) },
  });

  const recalled = await recallMemory(env, store, "query", ["thread", "channel", "team"], { maxItems: 10, maxTokens: 100 });
  assert.equal(recalled.length, 2);
  assert.equal(recalled[0].scope, "thread");
  assert.equal(recalled[1].scope, "team");
});

test("parseLearnedJsonl redacts secrets and ignores invalid lines", () => {
  const entries = parseLearnedJsonl('{"content":"token=abcd1234abcd","category":"fact","confidence":"high"}\nnot-json', "thread");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content.includes("[REDACTED]"), true);
  assert.equal(redactSecrets("api_key=secretsecretsecret"), "[REDACTED]");
});

test("applyRetention removes overflow and old items", () => {
  const now = Date.now();
  const items = [
    { id: "1", scope: "thread", content: "a", created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString(), source: "thread", version: 1, content_hash: "1", token_estimate: 1 },
    { id: "2", scope: "thread", content: "b", created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), source: "thread", version: 1, content_hash: "2", token_estimate: 1 },
    { id: "3", scope: "thread", content: "c", created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), source: "thread", version: 1, content_hash: "3", token_estimate: 1 },
  ];
  const result = applyRetention(items as any, { maxItemsPerScope: 2, maxAgeDays: 1, maxTotalBytes: 5 }, now);
  assert.equal(result.keep.length, 1);
  assert.equal(result.remove.length, 2);
});

test("reconcileMemory deletes orphan vectors and reindexes unindexed items", async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);
  await bucket.put("mem/reindex.json", JSON.stringify({
    id: "reindex",
    scope: "team",
    content: "needs index",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: "thread",
    version: 1,
    content_hash: "x",
    token_estimate: 2,
    unindexed: true,
  }));

  const deleted: string[] = [];
  let upserted = 0;
  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    PI_VECTORS: {
      upsert: async () => {
        upserted += 1;
      },
      deleteByIds: async (ids: string[]) => {
        deleted.push(...ids);
      },
      query: async () => ({ count: 0, matches: [] }),
      insert: async () => undefined,
      getByIds: async () => ({ vectors: [] }),
      describe: async () => ({ dimensions: 2, count: 0, metric: "cosine" }),
    } as unknown as VectorizeIndex,
  });

  const result = await reconcileMemory(env, store, ["orphan"]);
  assert.equal(result.deletedOrphans, 1);
  assert.equal(result.reindexed, 1);
  assert.deepEqual(deleted, ["orphan"]);
  assert.equal(upserted, 1);
});

test("embedText throttles calls when INGEST_EMBED_DELAY_MS is set", async () => {
  let callCount = 0;
  const env = makeEnv({
    AI: {
      run: async () => {
        callCount += 1;
        return { data: [[0.1, 0.2]] };
      },
    },
    INGEST_EMBED_DELAY_MS: "50",
  });

  const start = Date.now();
  await embedText(env, "first");
  await embedText(env, "second");
  const elapsed = Date.now() - start;

  assert.equal(callCount, 2);
  // Two calls with a 50ms minimum gap means the second call must wait ~50ms
  assert.ok(elapsed >= 40, `Expected elapsed >= 40ms, got ${elapsed}ms`);
});

test("appendDailyLearned appends entries and uploads to R2", async () => {
  const bucket = new FakeR2Bucket();
  let disk = "";
  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => disk,
      writeFile: async (_path: string, content: string) => {
        disk = content;
      },
    },
  });

  await appendDailyLearned(env, "2025-01-01", [{
    timestamp: "2025-01-01T00:00:00.000Z",
    scope: "thread",
    category: "fact",
    content: "token=abcd1234abcd",
    confidence: "high",
  }]);

  assert.match(disk, /\[REDACTED\]/);
  const uploaded = await bucket.get("daily/2025-01-01.learned.jsonl");
  assert.ok(uploaded);
});

test("compactScope triggers learned flush before replacing items", async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);
  await store.create({ id: "x", scope: "thread", content: "first fact", source: "thread" });
  await store.create({ id: "y", scope: "thread", content: "second fact", source: "thread" });

  let writes = 0;
  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => {
        writes += 1;
      },
    },
    AI: {
      run: async (_m, payload) => {
        if ("messages" in payload) {
          return { response: '{"content":"learned fact","category":"fact","confidence":"medium"}' };
        }
        return { data: [[0.1, 0.2]] };
      },
    },
    PI_VECTORS: {
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
      query: async () => ({ count: 0, matches: [] }),
      insert: async () => undefined,
      getByIds: async () => ({ vectors: [] }),
      describe: async () => ({ dimensions: 2, count: 0, metric: "cosine" }),
    } as unknown as VectorizeIndex,
  });

  const result = await compactScope(env, store, "thread");
  assert.ok(result.replaced >= 2);
  assert.ok(writes > 0);
  const flushed = await flushLearnedBeforeCompaction(env, "thread", "note", "2025-01-02");
  assert.equal(flushed.length, 1);
});
