import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import { AgentDO } from "./agent";
import type { SqlStorage } from "./storage";
import type { Env } from "./types";

class FakeSql implements SqlStorage {
  private messages: Array<{ id: number; threadId: string; role: string; content: string }> = [];
  private knowledge = "";
  private nextId = 1;
  private sessionState: { current_session_id: string; last_message_at: number } | null = null;

  getTotalMessageCount(): number {
    return this.messages.length;
  }

  exec(query: string, ...bindings: Array<string | number | null>) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("CREATE TABLE")) return { toArray: () => [] };

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
      return { toArray: () => this.messages.filter((row) => row.threadId === threadId) };
    }

    if (normalized.startsWith("INSERT INTO knowledge")) {
      this.knowledge = String(bindings[1]);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT content FROM knowledge")) {
      return { toArray: () => (this.knowledge ? [{ content: this.knowledge }] : []) };
    }

    if (normalized.startsWith("INSERT INTO rate_limits") || normalized.startsWith("SELECT count FROM rate_limits")) {
      return { toArray: () => [{ count: 1 }] };
    }

    if (normalized.includes("FROM session_state")) {
      return { toArray: () => this.sessionState ? [this.sessionState] : [] };
    }

    if (normalized.startsWith("INSERT INTO session_state")) {
      this.sessionState = {
        current_session_id: String(bindings[0]),
        last_message_at: Number(bindings[1])
      };
      return { toArray: () => [] };
    }

    if (normalized.includes("FROM session_summaries")) {
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }

  getMessageCountForThread(threadId: string): number {
    return this.messages.filter((row) => row.threadId === threadId).length;
  }
}

async function makeSignedRequest(body: string, secret: string): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const signature = `v0=${Array.from(new Uint8Array(signatureBytes)).map((n) => n.toString(16).padStart(2, "0")).join("")}`;

  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature
    },
    body
  });
}

describe("integration flow", () => {
  it("routes Slack event to DO, runs agent loop, and persists conversation state", async () => {
    const sql = new FakeSql();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "echo hi" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Command complete" }] });

    const sandbox = {
      exec: vi.fn().mockResolvedValue({ stdout: "hi", stderr: "", exitCode: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("knowledge")
    };

    const r2Data = new Map<string, string>();

    const env = {
      REPO_STORE: {
        put: vi.fn(async (key: string, value: unknown) => {
          r2Data.set(key, String(value));
        }),
        get: vi.fn(async (key: string) => {
          const value = r2Data.get(key);
          return value ? { text: async () => value } : null;
        })
      },
      SANDBOX: sandbox,
      ANTHROPIC_API_KEY: "key",
      SLACK_BOT_TOKEN: "token",
      SLACK_SIGNING_SECRET: "secret"
    } as unknown as Env;

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn().mockResolvedValue({ ts: "approval-ts" }) as never
    });

    const doStub = {
      fetch: vi.fn((_: string, init?: RequestInit) =>
        agent.fetch(
          new Request("https://agent.internal/event", {
            method: init?.method,
            headers: init?.headers,
            body: init?.body
          })
        )
      )
    };

    env.AGENT_DO = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => doStub)
    } as unknown as DurableObjectNamespace;

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined
    } as ExecutionContext;

    const threadTs = "1711111111.7777";
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        channel: "C111",
        text: "say hi",
        thread_ts: threadTs
      }
    });

    const response = await worker.fetch(await makeSignedRequest(body, env.SLACK_SIGNING_SECRET), env, ctx);
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(doStub.fetch).toHaveBeenCalledTimes(1);
    expect(sandbox.exec).toHaveBeenCalledWith("echo hi");
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C111", "Command complete");
    expect(sql.getTotalMessageCount()).toBeGreaterThan(0);
  });
});
