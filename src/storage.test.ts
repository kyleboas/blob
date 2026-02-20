import { describe, expect, it, vi } from "vitest";
import {
  getHistory,
  getKnowledge,
  getRateLimit,
  incrementRateLimit,
  initSchema,
  restoreRepoSnapshot,
  saveKnowledge,
  saveMessage,
  saveRepoSnapshot,
  syncKnowledgeFromSandbox,
  syncKnowledgeToSandbox,
  type SqlStorage
} from "./storage";

type Row = Record<string, unknown>;

class FakeSql implements SqlStorage {
  private messages: Array<{ id: number; threadId: string; role: string; content: string }> = [];
  private rateLimits = new Map<string, number>();
  private knowledge = "";
  private nextMessageId = 1;

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.trim().replace(/\s+/g, " ");

    if (normalized.startsWith("CREATE TABLE")) {
      return { toArray: () => [] };
    }

    if (normalized.startsWith("INSERT INTO conversation_messages")) {
      this.messages.push({
        id: this.nextMessageId++,
        threadId: String(bindings[0]),
        role: String(bindings[1]),
        content: String(bindings[2])
      });
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM conversation_messages")) {
      const threadId = String(bindings[0]);
      const rows = this.messages
        .filter((row) => row.threadId === threadId)
        .sort((a, b) => a.id - b.id)
        .map((row) => ({ role: row.role, content: row.content }));
      return { toArray: () => rows as Row[] };
    }

    if (normalized.startsWith("INSERT INTO rate_limits")) {
      const scope = String(bindings[0]);
      const key = String(bindings[1]);
      const mapKey = `${scope}:${key}`;
      const current = this.rateLimits.get(mapKey) ?? 0;
      this.rateLimits.set(mapKey, current + 1);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT count FROM rate_limits")) {
      const scope = String(bindings[0]);
      const key = String(bindings[1]);
      const mapKey = `${scope}:${key}`;
      const count = this.rateLimits.get(mapKey);
      return { toArray: () => (count === undefined ? [] : [{ count }]) };
    }

    if (normalized.startsWith("INSERT INTO knowledge")) {
      this.knowledge = String(bindings[1]);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT content FROM knowledge")) {
      return { toArray: () => (this.knowledge ? [{ content: this.knowledge }] : []) };
    }

    throw new Error(`Unhandled query in test fake: ${query}`);
  }
}

describe("storage schema and helpers", () => {
  it("initializes schema and saves/reads history", () => {
    const sql = new FakeSql();
    initSchema(sql);

    saveMessage(sql, "thread-1", { role: "user", content: "hello" });
    saveMessage(sql, "thread-1", { role: "assistant", content: "hi" });

    expect(getHistory(sql, "thread-1")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ]);
  });

  it("increments and reads rate limits", () => {
    const sql = new FakeSql();
    expect(getRateLimit(sql, "session", "abc")).toBe(0);
    expect(incrementRateLimit(sql, "session", "abc")).toBe(1);
    expect(incrementRateLimit(sql, "session", "abc")).toBe(2);
  });

  it("saves and retrieves knowledge", () => {
    const sql = new FakeSql();
    saveKnowledge(sql, "persisted knowledge");
    expect(getKnowledge(sql)).toBe("persisted knowledge");
  });
});

describe("R2 snapshot helpers", () => {
  it("saves snapshot from sandbox to r2", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put } as unknown as R2Bucket;

    const sandbox = {
      fileExists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue("file-content")
    };

    await saveRepoSnapshot(r2, "session-1", sandbox);

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0] as [string, string];
    expect(key).toBe("snapshots/session-1.json");
    expect(JSON.parse(body)).toHaveLength(4);
  });

  it("restores snapshot into sandbox", async () => {
    const files = [{ path: "AGENT.md", content: "knowledge" }];
    const r2 = {
      get: vi.fn().mockResolvedValue({ text: async () => JSON.stringify(files) })
    } as unknown as R2Bucket;

    const sandbox = { writeFile: vi.fn().mockResolvedValue(undefined) };

    const restored = await restoreRepoSnapshot(r2, "session-2", sandbox);

    expect(restored).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledWith("AGENT.md", "knowledge");
  });
});

describe("knowledge sync", () => {
  it("syncs knowledge to and from sandbox", async () => {
    const sql = new FakeSql();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue("sandbox knowledge");
    const fileExists = vi.fn().mockResolvedValue(true);

    saveKnowledge(sql, "local knowledge");
    await syncKnowledgeToSandbox(sql, { writeFile });
    await syncKnowledgeFromSandbox(sql, { readFile, fileExists });

    expect(writeFile).toHaveBeenCalledWith("AGENT.md", "local knowledge");
    expect(getKnowledge(sql)).toBe("sandbox knowledge");
  });

  it("skips sandbox write when knowledge is empty", async () => {
    const sql = new FakeSql();
    const writeFile = vi.fn().mockResolvedValue(undefined);

    await syncKnowledgeToSandbox(sql, { writeFile });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips sandbox read when AGENT.md does not exist", async () => {
    const sql = new FakeSql();
    const readFile = vi.fn().mockResolvedValue("");
    const fileExists = vi.fn().mockResolvedValue(false);

    await syncKnowledgeFromSandbox(sql, { readFile, fileExists });

    expect(readFile).not.toHaveBeenCalled();
    expect(getKnowledge(sql)).toBe("");
  });
});
