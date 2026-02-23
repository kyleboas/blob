import { describe, expect, it, vi } from "vitest";
import { AgentDO } from "./agent";
import type { Env } from "./types";
import type { SqlStorage } from "./storage";

interface HeartbeatRow {
  id: number;
  task: string;
  channel: string;
  status: string;
  result: string | null;
  created_at: number;
  updated_at: number;
}

class FakeSql implements SqlStorage {
  private messages: Array<{ id: number; threadId: string; role: string; content: string }> = [];
  private rateLimits = new Map<string, number>();
  private knowledge = "";
  private nextId = 1;
  private sessionState: { current_session_id: string; last_message_at: number } | null = null;
  private sessionSummaries: Array<{ id: number; session_id: string; summary: string; created_at: number }> = [];
  private summaryNextId = 1;
  private heartbeats: HeartbeatRow[] = [];
  private nextHeartbeatId = 1;

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("CREATE TABLE")) {
      return { toArray: () => [] };
    }

    if (normalized.startsWith("INSERT INTO conversation_messages")) {
      this.messages.push({
        id: this.nextId++,
        threadId: String(bindings[0]),
        role: String(bindings[1]),
        content: String(bindings[2])
      });
      return { toArray: () => [] };
    }

    if (normalized.startsWith("DELETE FROM conversation_messages")) {
      const threadId = String(bindings[0]);
      this.messages = this.messages.filter((m) => m.threadId !== threadId);
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM conversation_messages")) {
      const threadId = String(bindings[0]);
      return {
        toArray: () => this.messages.filter((m) => m.threadId === threadId).map((m) => ({ role: m.role, content: m.content }))
      };
    }

    if (normalized.startsWith("INSERT INTO rate_limits")) {
      const key = `${bindings[0]}:${bindings[1]}`;
      this.rateLimits.set(key, (this.rateLimits.get(key) ?? 0) + 1);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT count FROM rate_limits")) {
      const key = `${bindings[0]}:${bindings[1]}`;
      const count = this.rateLimits.get(key);
      return { toArray: () => (count === undefined ? [] : [{ count }]) };
    }

    if (normalized.startsWith("INSERT INTO knowledge")) {
      this.knowledge = String(bindings[1]);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT content FROM knowledge")) {
      return { toArray: () => (this.knowledge ? [{ content: this.knowledge }] : []) };
    }

    if (normalized.includes("FROM session_state")) {
      return {
        toArray: () => this.sessionState ? [this.sessionState] : []
      };
    }

    if (normalized.startsWith("INSERT INTO session_state")) {
      this.sessionState = {
        current_session_id: String(bindings[0] ?? bindings[0]),
        last_message_at: Number(bindings[1] ?? bindings[1])
      };
      return { toArray: () => [] };
    }

    if (normalized.startsWith("INSERT INTO session_summaries")) {
      this.sessionSummaries.push({
        id: this.summaryNextId++,
        session_id: String(bindings[0]),
        summary: String(bindings[1]),
        created_at: Math.floor(Date.now() / 1000)
      });
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM session_summaries")) {
      const limit = Number(bindings[0] ?? 5);
      const recent = this.sessionSummaries.slice(-limit);
      return {
        toArray: () => recent.map((s) => ({ session_id: s.session_id, summary: s.summary, created_at: s.created_at }))
      };
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
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000)
      });
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT last_insert_rowid()")) {
      const last = this.heartbeats.at(-1);
      return { toArray: () => (last ? [{ id: last.id }] : [{ id: 0 }]) };
    }

    if (normalized.includes("FROM heartbeats") && normalized.includes("status = 'pending'") && normalized.includes("LIMIT 1")) {
      const pending = this.heartbeats.find((h) => h.status === "pending");
      if (!pending) return { toArray: () => [] };
      pending.status = "running";
      return { toArray: () => [{ ...pending }] };
    }

    if (normalized.startsWith("UPDATE heartbeats SET status = 'running'")) {
      const id = Number(bindings[0]);
      const h = this.heartbeats.find((hb) => hb.id === id);
      if (h) h.status = "running";
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE heartbeats SET status = 'completed'")) {
      const result = String(bindings[0]);
      const id = Number(bindings[1]);
      const h = this.heartbeats.find((hb) => hb.id === id);
      if (h) { h.status = "completed"; h.result = result; }
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE heartbeats SET status = 'failed'")) {
      const result = String(bindings[0]);
      const id = Number(bindings[1]);
      const h = this.heartbeats.find((hb) => hb.id === id);
      if (h) { h.status = "failed"; h.result = result; }
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT 1 FROM heartbeats WHERE status = 'pending'")) {
      const hasPending = this.heartbeats.some((h) => h.status === "pending");
      return { toArray: () => (hasPending ? [{ 1: 1 }] : []) };
    }

    if (normalized.includes("FROM heartbeats") && normalized.includes("ORDER BY id DESC")) {
      const limit = Number(bindings[0] ?? 50);
      const rows = [...this.heartbeats].reverse().slice(0, limit);
      return { toArray: () => rows };
    }

    return { toArray: () => [] };
  }
}

function makeTestEnv() {
  const sandbox = {
    exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("knowledge"),
    fileExists: vi.fn().mockResolvedValue(true)
  };

  const r2Store = new Map<string, string>();
  const env: Env = {
    AGENT_DO: {} as DurableObjectNamespace,
    REPO_STORE: {
      put: vi.fn(async (key: string, value: unknown) => {
        r2Store.set(key, String(value));
      }),
      get: vi.fn(async (key: string) => {
        const value = r2Store.get(key);
        if (!value) return null;
        return { text: async () => value };
      })
    } as unknown as R2Bucket,
    SANDBOX: sandbox as unknown as Fetcher,
    ANTHROPIC_API_KEY: "key",
    SLACK_BOT_TOKEN: "token",
    SLACK_SIGNING_SECRET: "secret"
  };

  return { env, sandbox };
}

describe("AgentDO runAgentLoop", () => {
  it("runs tool call then final response", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "ls" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All done" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("list files", "C1", "thread-1");

    expect(result.finalText).toBe("All done");
    expect(sandbox.exec).toHaveBeenCalledWith("ls");
    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("You are Blob, a careful coding agent.")
      })
    );
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "All done");
  });

  it("includes a new user message for follow-up thread replies", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("first question", "C1", "thread-follow-up");
    await agent.runAgentLoop("follow up question", "C1", "thread-follow-up");

    expect(llmCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          { role: "user", content: "first question" },
          { role: "user", content: "follow up question" }
        ]
      })
    );
  });

  it("pauses and requests approval for dangerous commands", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "rm -rf tmp" } }] });
    const postSlackApproval = vi.fn().mockResolvedValue({ ts: "approval-ts" });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const setAlarm = vi.fn();

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: postSlackApproval as never
    });

    const result = await agent.runAgentLoop("cleanup", "C1", "1711111111.1111");

    expect(result.finalText).toContain("Paused pending approval");
    expect(postSlackApproval).toHaveBeenCalledTimes(1);
    expect(setAlarm).toHaveBeenCalledTimes(1);
  });

  it("enforces max steps", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "echo hi" } }]
    });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("loop", "C1", "thread-limit");

    expect(result.finalText).toContain("max steps");
    expect(result.steps).toBe(25);
  });

  it("posts error to Slack when agent loop throws", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn().mockRejectedValue(new Error("LLM unavailable")) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "hello", channel: "C1", thread_ts: "1711111111.7777" }
        })
      })
    );

    expect(response.status).toBe(202);
    expect(postSlackMessage).toHaveBeenCalledWith(
      "token",
      "C1",
      expect.stringContaining("LLM unavailable")
    );
  });


  it("persists snapshot even if runAgentLoop throws after a tool step", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "ls" } }] })
      .mockRejectedValueOnce(new Error("LLM follow-up failed"));

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await expect(agent.runAgentLoop("list files", "C1", "thread-persist-on-error")).rejects.toThrow("LLM follow-up failed");

    const putMock = env.REPO_STORE.put as unknown as ReturnType<typeof vi.fn>;
    expect(putMock).toHaveBeenCalledWith(
      "snapshots/thread-persist-on-error.json",
      expect.any(String)
    );
  });

  it("retries a failed tool call up to TOOL_RETRY_MAX times", async () => {
    vi.useFakeTimers();
    const sql = new FakeSql();
    const { env } = makeTestEnv();

    let callCount = 0;
    const sandbox = {
      exec: vi.fn(async () => {
        callCount += 1;
        if (callCount < 3) {
          return { stdout: "", stderr: "transient error", exitCode: 1 };
        }
        return { stdout: "success", stderr: "", exitCode: 0 };
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("")
    };
    const envWithSandbox = { ...env, SANDBOX: sandbox as unknown as Fetcher };

    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "flaky-cmd" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All good" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, envWithSandbox, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const loopPromise = agent.runAgentLoop("run flaky command", "C1", "thread-retry");

    // Advance timers to resolve the retry delays
    await vi.runAllTimersAsync();
    const result = await loopPromise;

    expect(result.finalText).toBe("All good");
    expect(callCount).toBe(3);
    vi.useRealTimers();
  });

  it("reports final failure to LLM after exhausting retries", async () => {
    vi.useFakeTimers();
    const sql = new FakeSql();
    const { env } = makeTestEnv();

    let callCount = 0;
    const sandbox = {
      exec: vi.fn(async () => {
        callCount += 1;
        return { stdout: "", stderr: "persistent error", exitCode: 2 };
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("")
    };
    const envWithSandbox = { ...env, SANDBOX: sandbox as unknown as Fetcher };

    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "bad-cmd" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Gave up" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, envWithSandbox, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const loopPromise = agent.runAgentLoop("run bad command", "C1", "thread-exhaust");

    await vi.runAllTimersAsync();
    const result = await loopPromise;

    expect(result.finalText).toBe("Gave up");
    // 1 initial attempt + TOOL_RETRY_MAX (2) retries = 3 total
    expect(callCount).toBe(3);
    vi.useRealTimers();
  });

  it("handles approval reaction callbacks", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn().mockResolvedValue({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "rm -rf tmp" } }] }) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn().mockResolvedValue({ ts: "approval-msg-ts" }) as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "run", channel: "C1", thread_ts: "1711111111.1111" }
        })
      })
    );

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "reaction",
          event: { type: "reaction_added", reaction: "thumbsup", item: { ts: "approval-msg-ts" } }
        })
      })
    );

    expect(sandbox.exec).toHaveBeenCalled();
    expect(postSlackMessage).toHaveBeenCalled();
  });


  it("posts a delayed thinking message only when processing exceeds threshold", async () => {
    vi.useFakeTimers();
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const llmCall = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: "text", text: "Done" }] }), 6_100))
    );

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const loopPromise = agent.runAgentLoop("slow request", "C1", "thread-slow-thinking");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Thinking...");

    await vi.runAllTimersAsync();
    await loopPromise;

    vi.useRealTimers();
  });

  it("does not post a thinking message for fast responses", async () => {
    vi.useFakeTimers();
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("fast request", "C1", "thread-fast-thinking");

    expect(postSlackMessage).not.toHaveBeenCalledWith("token", "C1", "Thinking...");
    vi.useRealTimers();
  });

  it("posts a confirmation when a Cloudflare deploy command succeeds", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "npx wrangler deploy" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Deployment done" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("deploy latest changes", "C1", "thread-deploy");

    expect(postSlackMessage).toHaveBeenCalledWith(
      "token",
      "C1",
      "✅ Cloudflare update applied successfully. Your latest changes should now be effective."
    );
  });

  it("posts a milestone update when tests pass", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    sandbox.exec.mockResolvedValue({ stdout: "5 passed", stderr: "", exitCode: 0 });
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "pytest" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Tests OK" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("run tests", "C1", "thread-tests");

    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Tests passed");
  });

  it("posts a milestone update when a git commit succeeds", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    sandbox.exec.mockResolvedValue({ stdout: "1 file changed", stderr: "", exitCode: 0 });
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "git commit -m 'add feature'" } }]
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("commit changes", "C1", "thread-commit");

    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Committed: add feature");
  });

  it("can create and use a dynamic tool in the same loop", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "1",
          name: "create_tool",
          input: {
            name: "list_top_files",
            description: "List top-level files in a path",
            command_template: "find {path} -maxdepth 1 -type f",
            args: ["path"]
          }
        }]
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "2",
          name: "list_top_files",
          input: { path: "/workspace/blob" }
        }]
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Dynamic tool worked" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("inspect files", "C1", "thread-dynamic-tool");

    expect(result.finalText).toBe("Dynamic tool worked");
    expect(sandbox.exec).toHaveBeenCalledWith("find /workspace/blob -maxdepth 1 -type f");
    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ name: "create_tool" })])
      })
    );
  });

});

describe("AgentDO heartbeat actions", () => {
  it("enqueue_heartbeat action stores a heartbeat and schedules an alarm", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const request = new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enqueue_heartbeat", task: "check for updates", channel: "C1" })
    });

    const response = await agent.fetch(request);
    expect(response.status).toBe(200);

    const body = await response.json() as { id: number };
    expect(typeof body.id).toBe("number");
    expect(setAlarm).toHaveBeenCalled();
  });

  it("list_heartbeats action returns the queue", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    // Enqueue one item first
    await agent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enqueue_heartbeat", task: "ping", channel: "C2" })
    }));

    const listReq = new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list_heartbeats" })
    });

    const resp = await agent.fetch(listReq);
    const body = await resp.json() as { heartbeats: Array<{ task: string }> };
    expect(body.heartbeats).toHaveLength(1);
    expect(body.heartbeats[0].task).toBe("ping");
  });

  it("alarm processes the next pending heartbeat and posts result", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Heartbeat done" }] }) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    // Enqueue a heartbeat
    await agent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enqueue_heartbeat", task: "run health checks", channel: "C-hb" })
    }));

    // Trigger the alarm
    await agent.alarm();

    expect(postSlackMessage).toHaveBeenCalledWith("token", "C-hb", "Heartbeat done");
  });
});
