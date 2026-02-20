import { describe, expect, it, vi } from "vitest";
import { AgentDO } from "./agent";
import type { Env } from "./types";
import type { SqlStorage } from "./storage";

class FakeSql implements SqlStorage {
  private messages: Array<{ id: number; threadId: string; role: string; content: string }> = [];
  private rateLimits = new Map<string, number>();
  private knowledge = "";
  private nextId = 1;

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

    return { toArray: () => [] };
  }
}

function makeTestEnv() {
  const sandbox = {
    exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("knowledge")
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
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "All done", "thread-1");
  });

  it("pauses and requests approval for dangerous commands", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "rm -rf tmp" } }] });
    const postSlackApproval = vi.fn().mockResolvedValue(undefined);
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
      expect.stringContaining("LLM unavailable"),
      "1711111111.7777"
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
      postSlackApproval: vi.fn().mockResolvedValue(undefined) as never
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
          event: { type: "reaction_added", reaction: "thumbsup", thread_ts: "1711111111.1111" }
        })
      })
    );

    expect(sandbox.exec).toHaveBeenCalled();
    expect(postSlackMessage).toHaveBeenCalled();
  });
});
