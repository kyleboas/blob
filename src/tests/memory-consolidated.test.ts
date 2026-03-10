import test from "node:test";
import assert from "node:assert/strict";
import {
  R2MemoryStore,
  writeMemoryItem,
  recallMemory,
  compactScope,
  applyRetention,
  validateIngestion,
  type MemoryItem,
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

function fakeVectorize(items: MemoryItem[]) {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  return {
    upsert: async (entries: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => {
      for (const entry of entries) {
        vectors.set(entry.id, { values: entry.values, metadata: entry.metadata ?? {} });
      }
    },
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
    },
    query: async (_vec: number[], opts?: VectorizeQueryOptions) => {
      const scope = String(opts?.filter && "scope" in opts.filter ? opts.filter.scope : "");
      const matches = items
        .filter((i) => i.scope === scope)
        .map((i) => ({ id: i.id, score: 0.9, metadata: { id: i.id, scope: i.scope } }));
      return { count: matches.length, matches };
    },
    insert: async () => undefined,
    getByIds: async () => ({ vectors: [] }),
    describe: async () => ({ dimensions: 2, count: vectors.size, metric: "cosine" }),
  } as unknown as VectorizeIndex;
}

test("write a memory item, recall it by semantic query", async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);

  const written = await store.create({ scope: "thread", content: "user prefers TypeScript", source: "thread" });
  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    PI_VECTORS: fakeVectorize([written]),
  });

  const recalled = await recallMemory(env, store, "what language does user prefer?", ["thread"]);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].content, "user prefers TypeScript");
});

test("compact a scope replaces multiple items with one", async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);

  await store.create({ id: "a", scope: "channel", content: "fact one", source: "thread" });
  await store.create({ id: "b", scope: "channel", content: "fact two", source: "thread" });
  await store.create({ id: "c", scope: "channel", content: "fact three", source: "thread" });

  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    AI: {
      run: async (_m: unknown, payload: unknown) => {
        if (payload && typeof payload === "object" && "messages" in payload) {
          return { response: '{"content":"compacted fact","category":"fact","confidence":"high"}' };
        }
        return { data: [[0.1, 0.2]] };
      },
    },
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => undefined,
    },
    PI_VECTORS: fakeVectorize([]),
  });

  const result = await compactScope(env, store, "channel");
  assert.ok(result.replaced >= 2);
  assert.ok(result.newItem);
  assert.match(result.newItem.content, /Compacted notes/);

  const remaining = await store.listByPrefix("mem/");
  const channelItems = remaining.filter((i) => i.scope === "channel");
  assert.equal(channelItems.length, 1);
});

test("retention policy removes old and overflow items", () => {
  const now = Date.now();
  const items: MemoryItem[] = [
    { id: "1", scope: "thread", content: "recent", created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString(), source: "thread", version: 1, content_hash: "h1", token_estimate: 2, unindexed: false },
    { id: "2", scope: "thread", content: "old item", created_at: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(), source: "thread", version: 1, content_hash: "h2", token_estimate: 2, unindexed: false },
    { id: "3", scope: "thread", content: "another", created_at: new Date(now - 2000).toISOString(), updated_at: new Date(now - 2000).toISOString(), source: "thread", version: 1, content_hash: "h3", token_estimate: 2, unindexed: false },
  ];

  const result = applyRetention(items, { maxItemsPerScope: 2, maxAgeDays: 30, maxTotalBytes: 10000 }, now);
  assert.equal(result.keep.length, 2);
  assert.equal(result.remove.length, 1);
  assert.equal(result.remove[0].id, "2");
});

test("duplicate detection rejects near-identical content", async () => {
  const env = makeEnv({
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    PI_VECTORS: {
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
      query: async () => ({ count: 1, matches: [{ id: "existing", score: 0.99 }] }),
      insert: async () => undefined,
      getByIds: async () => ({ vectors: [] }),
      describe: async () => ({ dimensions: 2, count: 1, metric: "cosine" }),
    } as unknown as VectorizeIndex,
  });

  const result = await validateIngestion(env, "thread", "already exists nearly identical");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "duplicate");
});

test("writeMemoryItem writes to R2 and can be read back", async () => {
  const bucket = new FakeR2Bucket();
  const store = new R2MemoryStore(bucket as unknown as R2Bucket);
  const env = makeEnv({
    REPO_STORE: bucket as unknown as R2Bucket,
    PI_VECTORS: {
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
      query: async () => ({ count: 0, matches: [] }),
      insert: async () => undefined,
      getByIds: async () => ({ vectors: [] }),
      describe: async () => ({ dimensions: 2, count: 0, metric: "cosine" }),
    } as unknown as VectorizeIndex,
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
  });

  const item = await writeMemoryItem(env, store, { scope: "team", content: "important decision", source: "thread" });
  assert.ok(item.id);
  assert.equal(item.scope, "team");
  assert.equal(item.content, "important decision");
  assert.ok(item.token_estimate > 0);

  const readBack = await store.read(item.id);
  assert.ok(readBack);
  assert.equal(readBack.content, "important decision");
});
