import { describe, expect, it, vi } from "vitest";
import { AgentDO } from "./agent";
import type { Env } from "./types";
import type { SqlStorage } from "./storage";

class FakeSql implements SqlStorage {
  private messages: Array<{ id: number; threadId: string; role: string; content: string }> = [];
  private rateLimits = new Map<string, number>();
  private knowledge = "";
  private nextId = 1;
  private sessionState: { current_session_id: string; last_message_at: number } | null = null;
  private sessionSummaries: Array<{ id: number; session_id: string; summary: string; created_at: number }> = [];
  private summaryNextId = 1;
  private backgroundTasks: Array<{ id: number; event_json: string; status: string }> = [];
  private backgroundTaskNextId = 1;
  private heartbeatGoal: { channel: string; goal: string } | null = null;
  private agentEvents: Array<{ id: number; thread_id: string; event_type: string; message: string; created_at: number }> = [];
  private agentEventNextId = 1;

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("CREATE TABLE")) {
      return { toArray: () => [] };
    }

    if (normalized.startsWith("PRAGMA table_info(background_tasks)")) {
      return {
        toArray: () => [{ name: "id" }, { name: "event_json" }, { name: "status" }, { name: "created_at" }]
      };
    }

    if (normalized.startsWith("ALTER TABLE background_tasks ADD COLUMN event_json")) {
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE background_tasks SET event_json")) {
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

    if (normalized.startsWith("INSERT INTO heartbeat_state")) {
      this.heartbeatGoal = { channel: String(bindings[0]), goal: String(bindings[1]) };
      return { toArray: () => [] };
    }

    if (normalized.startsWith("INSERT INTO agent_events")) {
      this.agentEvents.push({
        id: this.agentEventNextId++,
        thread_id: String(bindings[0]),
        event_type: String(bindings[1]),
        message: String(bindings[2]),
        created_at: Math.floor(Date.now() / 1000)
      });
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM agent_events")) {
      const threadId = String(bindings[0]);
      const limit = Number(bindings[1] ?? 200);
      const rows = this.agentEvents
        .filter((event) => event.thread_id === threadId)
        .slice(-limit)
        .reverse();
      return {
        toArray: () => rows.map((row) => ({
          event_type: row.event_type,
          message: row.message,
          created_at: row.created_at
        }))
      };
    }

    if (normalized.startsWith("SELECT channel, goal FROM heartbeat_state")) {
      return {
        toArray: () => this.heartbeatGoal ? [{ channel: this.heartbeatGoal.channel, goal: this.heartbeatGoal.goal }] : []
      };
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

    if (normalized.startsWith("INSERT INTO background_tasks")) {
      this.backgroundTasks.push({
        id: this.backgroundTaskNextId++,
        event_json: String(bindings[0]),
        status: "queued"
      });
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM background_tasks")) {
      const nextQueued = this.backgroundTasks.find((task) => task.status === "queued");
      return {
        toArray: () =>
          nextQueued
            ? [{ id: nextQueued.id, event_json: nextQueued.event_json }]
            : []
      };
    }

    if (normalized.startsWith("UPDATE background_tasks SET status = 'running'")) {
      const id = Number(bindings[0]);
      const task = this.backgroundTasks.find((row) => row.id === id);
      if (task) task.status = "running";
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE background_tasks SET status = 'done'")) {
      const id = Number(bindings[0]);
      const task = this.backgroundTasks.find((row) => row.id === id);
      if (task) task.status = "done";
      return { toArray: () => [] };
    }

    if (normalized.startsWith("UPDATE background_tasks SET status = 'failed'")) {
      const id = Number(bindings[0]);
      const task = this.backgroundTasks.find((row) => row.id === id);
      if (task) task.status = "failed";
      return { toArray: () => [] };
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
  it("returns mirrored global events for logs snapshots", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "logs_mirror",
          event: { type: "message", channel: "C1", text: "hello logs" }
        })
      })
    );

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", channel: "C1", text: "normal task" }
        })
      })
    );

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ action: "logs_snapshot" })
      })
    );

    const payload = await response.json() as { events: Array<{ eventType: string; message: string }> };
    expect(payload.events).toEqual([
      { eventType: "message", message: "[C1] hello logs" }
    ]);
  });

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
        systemPrompt: expect.stringContaining("Follow this AGENT.md knowledge when relevant:\nknowledge")
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


  it("queues message tasks for background processing when alarms are available", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done in background" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "work on this goal", channel: "C1", thread_ts: "1711111111.1234" }
        })
      })
    );

    expect(response.status).toBe(202);
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(llmCall).not.toHaveBeenCalled();

    await agent.alarm();

    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Done in background");
  });

  it("runs heartbeat work every 15 minutes without a new human prompt", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Heartbeat progress" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "Ship milestone A", channel: "C1" }
        })
      })
    );

    await agent.alarm();
    expect(llmCall).toHaveBeenCalledTimes(1);

    await agent.alarm();
    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Heartbeat progress");
  });

  it("continues heartbeat execution when snapshot restore fails", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const setAlarm = vi.fn();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "pwd" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Heartbeat recovered" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    env.REPO_STORE = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => {
        throw new Error("HTTP error! status: 500");
      })
    } as unknown as R2Bucket;

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "Ship milestone B", channel: "C1" }
        })
      })
    );

    await agent.alarm();

    expect(sandbox.exec).toHaveBeenCalledWith("pwd");
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Heartbeat recovered");
    expect(postSlackMessage).not.toHaveBeenCalledWith(
      "token",
      "C1",
      expect.stringContaining("Heartbeat error")
    );
  });

  it("queues a self-repair task after a heartbeat failure", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn();
    const llmCall = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP error! status: 500"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Self-repair completed" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "Ship milestone C", channel: "C1" }
        })
      })
    );

    await agent.alarm();

    expect(postSlackMessage).toHaveBeenCalledWith(
      "token",
      "C1",
      expect.stringContaining("queued a self-repair task")
    );

    await agent.alarm();

    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Self-repair completed");
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
});
