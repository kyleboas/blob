import { describe, expect, it, vi } from "vitest";
import {
  completeHeartbeat,
  enqueueHeartbeat,
  failHeartbeat,
  getLastHeartbeatChannel,
  getHistory,
  getKnowledge,
  getNextPendingHeartbeat,
  getRateLimit,
  hasPendingHeartbeats,
  incrementRateLimit,
  initSchema,
  listActiveSubAgents,
  listHeartbeats,
  markSubAgentDone,
  registerSubAgent,
  listRecentOperatorFeedback,
  saveOperatorFeedback,
  restoreRepoSnapshot,
  saveKnowledge,
  saveMessage,
  saveRepoSnapshot,
  syncKnowledgeFromSandbox,
  syncKnowledgeToSandbox,
  type SqlStorage,
  __testables
} from "./storage";

type Row = Record<string, unknown>;

interface HeartbeatRow {
  id: number;
  task: string;
  channel: string;
  status: string;
  result: string | null;
  created_at: number;
  updated_at: number;
}

interface OperatorFeedbackRow {
  id: number;
  feedback: string;
  channel: string | null;
  session_id: string | null;
  created_at: number;
}

interface SubAgentRow {
  id: number;
  channel: string;
  do_name: string;
  status: string;
  created_at: number;
  updated_at: number;
}

class FakeSql implements SqlStorage {
  private messages: Array<{ id: number; threadId: string; role: string; content: string }> = [];
  private rateLimits = new Map<string, number>();
  private knowledge = "";
  private nextMessageId = 1;
  private heartbeats: HeartbeatRow[] = [];
  private nextHeartbeatId = 1;
  private heartbeatTimestamp = 1;
  private subAgents: SubAgentRow[] = [];
  private nextSubAgentId = 1;
  private operatorFeedback: OperatorFeedbackRow[] = [];
  private nextFeedbackId = 1;

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

    // Heartbeat queries
    if (normalized.startsWith("INSERT INTO heartbeats")) {
      const id = this.nextHeartbeatId++;
      this.heartbeats.push({
        id,
        task: String(bindings[0]),
        channel: String(bindings[1]),
        status: "pending",
        result: null,
        created_at: this.heartbeatTimestamp,
        updated_at: this.heartbeatTimestamp
      });
      this.heartbeatTimestamp += 1;
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT last_insert_rowid()")) {
      const heartbeatId = this.heartbeats.at(-1)?.id ?? 0;
      const feedbackId = this.operatorFeedback.at(-1)?.id ?? 0;
      return { toArray: () => [{ id: Math.max(heartbeatId, feedbackId) }] };
    }

    if (normalized.includes("FROM heartbeats") && normalized.includes("status = 'pending'") && normalized.includes("LIMIT 1")) {
      const pending = this.heartbeats.find((h) => h.status === "pending");
      if (!pending) return { toArray: () => [] };
      pending.status = "running";
      return { toArray: () => [{ ...pending }] as Row[] };
    }

    if (normalized.startsWith("UPDATE heartbeats SET status = 'running'")) {
      const id = Number(bindings[0]);
      const h = this.heartbeats.find((hb) => hb.id === id);
      if (h) { h.status = "running"; h.updated_at = this.heartbeatTimestamp++; }
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE heartbeats SET status = 'completed'")) {
      const result = String(bindings[0]);
      const id = Number(bindings[1]);
      const h = this.heartbeats.find((hb) => hb.id === id);
      if (h) { h.status = "completed"; h.result = result; h.updated_at = this.heartbeatTimestamp++; }
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE heartbeats SET status = 'failed'")) {
      const result = String(bindings[0]);
      const id = Number(bindings[1]);
      const h = this.heartbeats.find((hb) => hb.id === id);
      if (h) { h.status = "failed"; h.result = result; h.updated_at = this.heartbeatTimestamp++; }
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT 1 FROM heartbeats WHERE status = 'pending'")) {
      const hasPending = this.heartbeats.some((h) => h.status === "pending");
      return { toArray: () => (hasPending ? [{ 1: 1 }] : []) };
    }

    if (normalized.includes("FROM heartbeats") && normalized.includes("ORDER BY id DESC")) {
      const limit = Number(bindings[0] ?? 50);
      const rows = [...this.heartbeats].reverse().slice(0, limit);
      return { toArray: () => rows as unknown as Row[] };
    }

    if (normalized.includes("SELECT channel FROM heartbeats") && normalized.includes("ORDER BY updated_at DESC")) {
      const latest = [...this.heartbeats]
        .sort((a, b) => (b.updated_at - a.updated_at) || (b.id - a.id))[0];
      return { toArray: () => (latest ? [{ channel: latest.channel }] : []) };
    }

    if (normalized.startsWith("INSERT INTO operator_feedback")) {
      const id = this.nextFeedbackId++;
      this.operatorFeedback.push({
        id,
        feedback: String(bindings[0]),
        channel: bindings[1] == null ? null : String(bindings[1]),
        session_id: bindings[2] == null ? null : String(bindings[2]),
        created_at: Math.floor(Date.now() / 1000)
      });
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM operator_feedback") && normalized.includes("ORDER BY id DESC")) {
      const limit = Number(bindings[0] ?? 5);
      const rows = [...this.operatorFeedback].reverse().slice(0, limit);
      return { toArray: () => rows as unknown as Row[] };
    }

    // Sub-agent queries
    if (normalized.startsWith("INSERT OR IGNORE INTO sub_agents")) {
      const channel = String(bindings[0]);
      const doName = String(bindings[1]);
      if (!this.subAgents.find((s) => s.do_name === doName)) {
        this.subAgents.push({
          id: this.nextSubAgentId++,
          channel,
          do_name: doName,
          status: "running",
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000)
        });
      }
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM sub_agents") && normalized.includes("status = 'running'")) {
      const channel = String(bindings[0]);
      const rows = this.subAgents
        .filter((s) => s.channel === channel && s.status === "running")
        .sort((a, b) => b.id - a.id);
      return { toArray: () => rows.map((s) => ({ do_name: s.do_name })) as Row[] };
    }

    if (normalized.startsWith("UPDATE sub_agents SET status =")) {
      const status = String(bindings[0]);
      const doName = String(bindings[1]);
      const sa = this.subAgents.find((s) => s.do_name === doName);
      if (sa) sa.status = status;
      return { toArray: () => [] };
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
      exec: vi.fn().mockResolvedValue({ stdout: " M src/agent.ts\n?? src/new-file.ts\n", stderr: "", exitCode: 0 }),
      fileExists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue("file-content")
    };

    await saveRepoSnapshot(r2, "session-1", sandbox);

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0] as [string, string];
    expect(key).toBe("snapshots/session-1.json");
    const files = JSON.parse(body) as Array<{ path: string; content: string }>;
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.some((file) => file.path === "src/new-file.ts")).toBe(true);
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


describe("git status parser", () => {
  it("parses changed paths from git status output", () => {
    const output = " M src/agent.ts\nR  old-name.ts -> src/new-name.ts\nD  removed.ts\n?? src/new-file.ts\n";

    expect(__testables.parseChangedPaths(output)).toEqual([
      "src/agent.ts",
      "src/new-name.ts",
      "src/new-file.ts"
    ]);
  });
});

describe("knowledge sync", () => {
  it("syncs knowledge to and from sandbox", async () => {
    const sql = new FakeSql();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue("sandbox knowledge");

    saveKnowledge(sql, "local knowledge");
    await syncKnowledgeToSandbox(sql, { writeFile });
    await syncKnowledgeFromSandbox(sql, { readFile });

    expect(writeFile).toHaveBeenCalledWith("AGENT.md", "local knowledge");
    expect(readFile).toHaveBeenCalledWith("AGENT.md");
    expect(getKnowledge(sql)).toBe("sandbox knowledge");
  });

  it("skips sandbox write when knowledge is empty", async () => {
    const sql = new FakeSql();
    const writeFile = vi.fn().mockResolvedValue(undefined);

    await syncKnowledgeToSandbox(sql, { writeFile });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips saving knowledge when AGENT.md does not exist in sandbox", async () => {
    const sql = new FakeSql();
    const readFile = vi.fn().mockRejectedValue(new Error("file not found"));

    await syncKnowledgeFromSandbox(sql, { readFile });

    expect(getKnowledge(sql)).toBe("");
  });
});

describe("operator feedback helpers", () => {
  it("stores feedback with metadata and returns newest first", () => {
    const sql = new FakeSql();

    const firstId = saveOperatorFeedback(sql, "Focus on reliability", "C-ops", "session-1");
    const secondId = saveOperatorFeedback(sql, "Avoid frontend tasks", null, null);

    const feedback = listRecentOperatorFeedback(sql, 5);
    expect(firstId).toBeGreaterThan(0);
    expect(secondId).toBeGreaterThanOrEqual(firstId);
    expect(feedback[0]).toMatchObject({ feedback: "Avoid frontend tasks", channel: null, sessionId: null });
    expect(feedback[1]).toMatchObject({ feedback: "Focus on reliability", channel: "C-ops", sessionId: "session-1" });
  });
});

describe("heartbeat helpers", () => {
  it("enqueues a heartbeat and returns its id", () => {
    const sql = new FakeSql();
    const id = enqueueHeartbeat(sql, "run tests", "C123");
    expect(id).toBeGreaterThan(0);
  });

  it("getNextPendingHeartbeat returns null when queue is empty", () => {
    const sql = new FakeSql();
    expect(getNextPendingHeartbeat(sql)).toBeNull();
  });

  it("getNextPendingHeartbeat returns and claims the next pending heartbeat", () => {
    const sql = new FakeSql();
    enqueueHeartbeat(sql, "task A", "C1");
    enqueueHeartbeat(sql, "task B", "C2");

    const hb = getNextPendingHeartbeat(sql);
    expect(hb).not.toBeNull();
    expect(hb!.task).toBe("task A");
    expect(hb!.channel).toBe("C1");
    expect(hb!.status).toBe("running");
  });

  it("hasPendingHeartbeats returns false when empty", () => {
    const sql = new FakeSql();
    expect(hasPendingHeartbeats(sql)).toBe(false);
  });

  it("hasPendingHeartbeats returns true when there are pending heartbeats", () => {
    const sql = new FakeSql();
    enqueueHeartbeat(sql, "check deps", "C1");
    expect(hasPendingHeartbeats(sql)).toBe(true);
  });

  it("completeHeartbeat marks the heartbeat as completed with a result", () => {
    const sql = new FakeSql();
    const id = enqueueHeartbeat(sql, "build", "C1");
    getNextPendingHeartbeat(sql); // moves to running
    completeHeartbeat(sql, id, "build succeeded");

    const all = listHeartbeats(sql);
    expect(all[0].status).toBe("completed");
    expect(all[0].result).toBe("build succeeded");
  });

  it("failHeartbeat marks the heartbeat as failed with an error", () => {
    const sql = new FakeSql();
    const id = enqueueHeartbeat(sql, "deploy", "C1");
    getNextPendingHeartbeat(sql);
    failHeartbeat(sql, id, "timeout");

    const all = listHeartbeats(sql);
    expect(all[0].status).toBe("failed");
    expect(all[0].result).toBe("timeout");
  });

  it("listHeartbeats returns heartbeats in reverse-chronological order", () => {
    const sql = new FakeSql();
    enqueueHeartbeat(sql, "first", "C1");
    enqueueHeartbeat(sql, "second", "C1");

    const list = listHeartbeats(sql);
    expect(list).toHaveLength(2);
    expect(list[0].task).toBe("second");
    expect(list[1].task).toBe("first");
  });

  it("getLastHeartbeatChannel returns the most recently updated heartbeat channel", () => {
    const sql = new FakeSql();
    enqueueHeartbeat(sql, "first", "C1");
    enqueueHeartbeat(sql, "second", "C2");

    // Mark first heartbeat updated after second so it becomes most recent.
    completeHeartbeat(sql, 1, "done");

    expect(getLastHeartbeatChannel(sql)).toBe("C1");
  });

  it("getLastHeartbeatChannel returns null when there are no heartbeats", () => {
    const sql = new FakeSql();
    expect(getLastHeartbeatChannel(sql)).toBeNull();
  });
});

describe("sub-agent registry helpers", () => {
  it("registerSubAgent stores a new entry and listActiveSubAgents returns it", () => {
    const sql = new FakeSql();
    registerSubAgent(sql, "C1", "task-agent:C1:abc");

    const active = listActiveSubAgents(sql, "C1");
    expect(active).toContain("task-agent:C1:abc");
  });

  it("listActiveSubAgents only returns agents for the requested channel", () => {
    const sql = new FakeSql();
    registerSubAgent(sql, "C1", "task-agent:C1:one");
    registerSubAgent(sql, "C2", "task-agent:C2:two");

    expect(listActiveSubAgents(sql, "C1")).toEqual(["task-agent:C1:one"]);
    expect(listActiveSubAgents(sql, "C2")).toEqual(["task-agent:C2:two"]);
  });

  it("markSubAgentDone removes the agent from the active list", () => {
    const sql = new FakeSql();
    registerSubAgent(sql, "C1", "task-agent:C1:abc");
    expect(listActiveSubAgents(sql, "C1")).toHaveLength(1);

    markSubAgentDone(sql, "task-agent:C1:abc", "completed");
    expect(listActiveSubAgents(sql, "C1")).toHaveLength(0);
  });

  it("registerSubAgent is idempotent for the same do_name", () => {
    const sql = new FakeSql();
    registerSubAgent(sql, "C1", "task-agent:C1:xyz");
    registerSubAgent(sql, "C1", "task-agent:C1:xyz"); // duplicate

    const active = listActiveSubAgents(sql, "C1");
    expect(active).toHaveLength(1);
  });
});
