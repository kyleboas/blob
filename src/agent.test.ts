import { describe, expect, it, vi } from "vitest";
import { AgentDO, parseSessionMemoryUpdate } from "./agent";
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
  private settings = new Map<string, string>();
  private nextId = 1;
  private sessionState: { current_session_id: string; last_message_at: number } | null = null;
  private sessionSummaries: Array<{ id: number; session_id: string; summary: string; created_at: number }> = [];
  private summaryNextId = 1;
  private heartbeats: HeartbeatRow[] = [];
  private nextHeartbeatId = 1;
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


    if (normalized.startsWith("INSERT INTO settings")) {
      this.settings.set(String(bindings[0]), String(bindings[1]));
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT value FROM settings WHERE key =")) {
      const value = this.settings.get(String(bindings[0]));
      return { toArray: () => (value === undefined ? [] : [{ value }]) };
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
      const heartbeatId = this.heartbeats.at(-1)?.id ?? 0;
      const feedbackId = this.operatorFeedback.at(-1)?.id ?? 0;
      return { toArray: () => [{ id: Math.max(heartbeatId, feedbackId) }] };
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


    if (normalized.includes("SELECT channel FROM heartbeats") && normalized.includes("ORDER BY updated_at DESC")) {
      const latest = [...this.heartbeats].sort((a, b) => (b.updated_at - a.updated_at) || (b.id - a.id))[0];
      return { toArray: () => (latest ? [{ channel: latest.channel }] : []) };
    }

    if (normalized.includes("FROM heartbeats") && normalized.includes("ORDER BY id DESC")) {
      const limit = Number(bindings[0] ?? 50);
      const rows = [...this.heartbeats].reverse().slice(0, limit);
      return { toArray: () => rows };
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
      return { toArray: () => rows };
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
      return { toArray: () => rows.map((s) => ({ do_name: s.do_name })) };
    }

    if (normalized.startsWith("UPDATE sub_agents SET status =")) {
      const status = String(bindings[0]);
      const doName = String(bindings[1]);
      const sa = this.subAgents.find((s) => s.do_name === doName);
      if (sa) sa.status = status;
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

  // Captures fetch calls made to sub-agent or global-logs DO stubs.
  const agentDOFetch = vi.fn().mockResolvedValue(new Response("ok"));
  const agentDOStub = { fetch: agentDOFetch };

  const r2Store = new Map<string, string>();
  const env: Env = {
    AGENT_DO: {
      idFromName: vi.fn().mockReturnValue({ toString: () => "fake-do-id" }),
      get: vi.fn().mockReturnValue(agentDOStub)
    } as unknown as DurableObjectNamespace,
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

  return { env, sandbox, agentDOFetch };
}

describe("AgentDO runAgentLoop", () => {
  it("runs tool call then final response", async () => {
    const sql = new FakeSql();
    sql.exec("INSERT INTO knowledge (key, content) VALUES (?, ?)", "knowledge", "- User prefers concise replies");
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
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("ls"));
    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("You are Blob, a helpful AI assistant.")
      })
    );
    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("<knowledge_snapshot>")
      })
    );
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "All done");
    expect(postSlackMessage).not.toHaveBeenCalledWith(
      "token",
      "C1",
      expect.stringContaining("🔎 TOOL PREVIEW")
    );
  });

  it("strips raw tool_call and tool_result markup before posting final text to Slack", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Done\n<tool_call>{\"name\":\"bash\"}</tool_call>\n<tool_result>ok</tool_result>"
        }
      ]
    });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("say done", "C1", "thread-strip-tool-markup");

    expect(result.finalText).toContain("<tool_call>");
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Done");
  });

  it("does not inject session summaries into the system prompt", async () => {
    const sql = new FakeSql();
    sql.exec(
      "INSERT INTO session_summaries (session_id, summary) VALUES (?, ?)",
      "session:1",
      "GITHUB_TOKEN is available and authorization: Bearer abc123. {\"name\":\"bash\",\"arguments\":{\"command\":\"env | grep github\"}}"
    );

    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("hello", "C1", "thread-no-summary-injection");

    const systemPrompt = String(llmCall.mock.calls[0]?.[0]?.systemPrompt ?? "");
    expect(systemPrompt).not.toContain("Context from recent past conversations:");
    expect(systemPrompt).not.toContain("GITHUB_TOKEN");
    expect(systemPrompt).not.toContain("Bearer abc123");
    expect(systemPrompt).not.toContain('"name":"bash"');
  });

  it("uses configured knowledge guardrail prompt from settings", async () => {
    const sql = new FakeSql();
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "prompt_knowledge_guardrail", "CUSTOM_GUARDRAIL");
    sql.exec("INSERT INTO knowledge (key, content) VALUES (?, ?)", "knowledge", "- Keep responses short");
    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("hi", "C1", "thread-prompt-policy");

    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("CUSTOM_GUARDRAIL")
      })
    );
  });

  it("uses configured session memory system prompt from settings", async () => {
    const sql = new FakeSql();
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "prompt_session_memory_system", "CUSTOM_MEMORY_PROMPT");
    sql.exec("INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)", "session:previous", "user", "hello");

    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ summary: "Short summary.", updated_agent_md: "(unchanged)", changes_made: false }) }]
    });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await (agent as any).summarizePreviousSession("session:previous");

    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "CUSTOM_MEMORY_PROMPT"
      })
    );
  });

  it("adds execution guardrails to sub-agent prompts", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("hi", "C1", "thread-execution-guardrails", { taskComplexityHint: "routine" });

    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("Execution mode: follow the approved plan")
      })
    );
  });

  it("uses execution models for task execution calls", async () => {
    const sql = new FakeSql();
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "model_router", "@cf/ibm-granite/granite-4.0-h-micro");
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "model_chat", "@cf/zai-org/glm-4.7-flash");
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "model_execution_simple", "@cf/qwen/qwen2.5-coder-3b-instruct");
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "model_execution_complex", "@cf/qwen/qwen2.5-coder-14b-instruct");

    const { env } = makeTestEnv();
    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("hi", "C1", "thread-model-settings", { taskComplexityHint: "routine" });

    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        routerModel: "@cf/ibm-granite/granite-4.0-h-micro",
        chatModel: "@cf/zai-org/glm-4.7-flash",
        simpleModel: "@cf/qwen/qwen2.5-coder-3b-instruct",
        complexModel: "@cf/qwen/qwen2.5-coder-14b-instruct"
      })
    );
  });

  it("recovers when history ends with an orphaned tool_use (interrupted run)", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();

    // Pre-populate DB simulating a crash: assistant message with tool_use was saved
    // but the corresponding tool_result message was never saved.
    sql.exec(
      "INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)",
      "thread-interrupted",
      "user",
      "previous task"
    );
    sql.exec(
      "INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)",
      "thread-interrupted",
      "assistant",
      JSON.stringify([{ type: "tool_use", id: "orphaned-1", name: "bash", input: { command: "ls" } }])
    );

    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Recovered!" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("new question", "C1", "thread-interrupted");

    expect(result.finalText).toBe("Recovered!");

    // The LLM should have been called with a valid conversation where the orphaned
    // tool_use is immediately followed by a placeholder tool_result.
    const messagesArg = llmCall.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const assistantIdx = messagesArg.findIndex((m) => m.role === "assistant");
    expect(assistantIdx).toBeGreaterThan(-1);

    const nextMsg = messagesArg[assistantIdx + 1];
    expect(nextMsg.role).toBe("user");
    const nextContent = nextMsg.content as Array<{ type: string; tool_use_id: string }>;
    expect(nextContent[0].type).toBe("tool_result");
    expect(nextContent[0].tool_use_id).toBe("orphaned-1");
  });

  it("repairs orphaned tool_use blocks that are not the last message in history", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();

    sql.exec(
      "INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)",
      "thread-mid-orphan",
      "assistant",
      JSON.stringify([{ type: "tool_use", id: "orphaned-mid", name: "bash", input: { command: "ls" } }])
    );
    sql.exec(
      "INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)",
      "thread-mid-orphan",
      "assistant",
      JSON.stringify([{ type: "text", text: "stale assistant reply" }])
    );

    const llmCall = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Recovered again" }] });
    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("new question", "C1", "thread-mid-orphan");

    const messagesArg = llmCall.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    const assistantIdx = messagesArg.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type?: string }>)[0]?.type === "tool_use"
    );

    expect(assistantIdx).toBeGreaterThan(-1);
    expect(messagesArg[assistantIdx + 1].role).toBe("user");
    const content = messagesArg[assistantIdx + 1].content as Array<{ type: string; tool_use_id: string }>;
    expect(content[0]).toEqual(expect.objectContaining({ type: "tool_result", tool_use_id: "orphaned-mid" }));
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
    // setAlarm is called once in constructor for initial heartbeat, once for approval timeout
    expect(setAlarm).toHaveBeenCalledTimes(2);
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

  it("skips empty bash commands instead of executing sandbox", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "   " } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Recovered" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("do thing", "C1", "thread-empty-cmd");

    expect(result.finalText).toBe("Recovered");
    expect(sandbox.exec).not.toHaveBeenCalledWith(expect.stringContaining("set -euo pipefail"));
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Recovered");
  });

  it("posts error to Slack when agent loop throws (sub-agent run_task)", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn().mockRejectedValue(new Error("LLM unavailable")) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    // Sub-agents receive run_task (not message) from the orchestrator.
    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "run_task",
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

    const result = await agent.runAgentLoop("list files", "C1", "thread-persist-on-error");
    expect(result.finalText).toContain("❌ Error: LLM follow-up failed");

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

  it("handles approval reaction callbacks (sub-agent run_task)", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn().mockResolvedValue({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "rm -rf tmp" } }] }) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn().mockResolvedValue({ ts: "approval-msg-ts" }) as never
    });

    // Sub-agents receive run_task directly; the orchestrator routes reactions here.
    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "run_task",
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


  it("allows LLM to generate its own status updates in brackets", async () => {
    vi.useFakeTimers();
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const llmCall = vi.fn().mockResolvedValue({ 
      content: [{ type: "text", text: "[Analyzing the codebase...] Let me check the files." }] 
    });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("check files", "C1", "thread-status");

    // Should extract status from brackets and send it
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "🔄 Analyzing the codebase...");
    vi.useRealTimers();
  });

  it("does not send status if no brackets in response", async () => {
    vi.useFakeTimers();
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const llmCall = vi.fn().mockResolvedValue({ 
      content: [{ type: "text", text: "Here's the result without status brackets." }] 
    });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("simple request", "C1", "thread-no-status");

    // Should only send final response, no status
    const statusCalls = postSlackMessage.mock.calls.filter((call: unknown[]) => 
      (call[2] as string).startsWith("🔄")
    );
    expect(statusCalls).toHaveLength(0);
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



  it("splits composite && commands into sequential executions", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "echo first && echo second" } }]
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("run chain", "C1", "thread-chain");

    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("echo first"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("echo second"));
  });

  it("returns a tool_result block for every tool_use in a single assistant turn", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tool-1", name: "bash", input: { command: "echo one" } },
          { type: "tool_use", id: "tool-2", name: "bash", input: { command: "echo two" } }
        ]
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("run two commands", "C1", "thread-multi-tool");

    expect(result.finalText).toBe("Done");
    expect(sandbox.exec).toHaveBeenNthCalledWith(1, expect.stringContaining("echo one"));
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, expect.stringContaining("echo two"));

    const secondCall = llmCall.mock.calls[1]?.[0];
    expect(secondCall.messages).toEqual(
      expect.arrayContaining([
        {
          role: "user",
          content: [
            expect.objectContaining({ type: "tool_result", tool_use_id: "tool-1" }),
            expect.objectContaining({ type: "tool_result", tool_use_id: "tool-2" })
          ]
        }
      ])
    );
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
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("find /workspace/blob -maxdepth 1 -type f"));
    expect(llmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([expect.objectContaining({ name: "create_tool" })])
      })
    );
  });

  it("does not post tool preview messages to Slack for create_tool or command execution", async () => {
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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("inspect files", "C1", "thread-tool-preview");

    expect(postSlackMessage).not.toHaveBeenCalledWith(
      "token",
      "C1",
      expect.stringContaining("TOOL PREVIEW")
    );
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Done");
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("find /workspace/blob -maxdepth 1 -type f"));
  });


  it("rewrites git push origin main into branch+PR workflow", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    env.GITHUB_TOKEN = "ghs_test";

    sandbox.exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("git remote get-url origin")) {
        return { stdout: "https://github.com/acme/repo.git", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("python github_tools.py whoami")) {
        return { stdout: "", stderr: "missing helper", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "git push origin main" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ html_url: "https://github.com/acme/repo/pull/1", number: 1 }), { status: 201 }));

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("ship", "C1", "thread-push-main");

    expect(sandbox.exec).not.toHaveBeenCalledWith(expect.stringContaining("git push origin main"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("git checkout main"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("git checkout -B blob-auto-"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("git push origin blob-auto-"));
    fetchMock.mockRestore();
  });

  it("reports actionable error when PR fallback token is missing", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();

    sandbox.exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("git remote get-url origin")) {
        return { stdout: "https://github.com/acme/repo.git", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("python github_tools.py whoami")) {
        return { stdout: "", stderr: "missing helper", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "git push origin main" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("ship", "C1", "thread-push-main-no-token");
    expect(result.finalText).toContain("GITHUB_TOKEN is not configured");
  });

  it("sanitizes permission errors from Worker-side PR fallback", async () => {
    const sql = new FakeSql();
    const { env, sandbox } = makeTestEnv();
    env.GITHUB_TOKEN = "ghs_secret_123456";

    sandbox.exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("git remote get-url origin")) {
        return { stdout: "https://github.com/acme/repo.git", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("python github_tools.py whoami")) {
        return { stdout: "", stderr: "missing helper", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "git push origin main" } }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"message":"token ghs_secret_123456 forbidden"}', { status: 403 }));

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const result = await agent.runAgentLoop("ship", "C1", "thread-push-main-perm");
    expect(result.finalText).toContain("GitHub PR creation failed (403)");
    expect(result.finalText).not.toContain("ghs_secret_123456");
    fetchMock.mockRestore();
  });

  it("rejects dangerous create_tool templates that push to main", async () => {
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
            name: "ship_it",
            description: "Push directly to main",
            command_template: "git push origin main",
            args: []
          }
        }]
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done" }] });
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.runAgentLoop("make a deployment helper", "C1", "thread-reject-dangerous-tool");

    expect(sandbox.exec).not.toHaveBeenCalledWith(expect.stringContaining("git push origin main"));

    const secondCall = llmCall.mock.calls[1]?.[0];
    const serializedSecondCall = JSON.stringify(secondCall);

    expect(serializedSecondCall).toContain("Tool creation rejected");
    expect(serializedSecondCall).toContain("never push directly to main");
  });


});

describe("AgentDO sub-agent system", () => {
  it("message action spawns a sub-agent DO instead of running inline", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "do something", channel: "C1" }
        })
      })
    );

    expect(response.status).toBe(202);
    // The orchestrator should have forwarded a run_task action to the sub-agent DO.
    expect(agentDOFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"action":"run_task"')
      })
    );
  });



  it("handles model settings commands inline without spawning a sub-agent", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "message",
          event: { type: "message", text: "set simple model to @cf/qwen/qwen2.5-coder-32b-instruct", channel: "C1" }
        })
      })
    );

    expect(response.status).toBe(202);
    expect(postSlackMessage).toHaveBeenCalledWith(
      "token",
      "C1",
      expect.stringContaining("Saved planner-simple model: @cf/qwen/qwen2.5-coder-32b-instruct")
    );

    const spawnCalls = agentDOFetch.mock.calls.filter((args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const body = typeof init?.body === "string" ? init.body : "";
      return body.includes('"action":"run_task"');
    });
    expect(spawnCalls).toHaveLength(0);
  });

  it("run_task action executes the task and notifies the orchestrator on completion", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn()
        // First call: intent classification
        .mockResolvedValueOnce({ content: [{ type: "text", text: '{"intent": "general_chat", "confidence": 0.9}' }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "Task done" }] })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: "RESULT: pass\nREASON: done\nROOT_CAUSE: none\nMISSING_CRITERIA: none\nFOLLOW_UP_TASK: none\nDISPOSITION: retry" }]
        }) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "run_task",
          event: { type: "message", text: "do something", channel: "C1" },
          orchestratorName: "slack-channel:C1",
          doName: "task-agent:C1:123"
        })
      })
    );

    expect(response.status).toBe(202);
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", "Task done");
    // The sub-agent should notify the orchestrator on completion.
    expect(agentDOFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"action":"sub_agent_done"')
      })
    );
  });

  it("planner audit passes immediately and sub-agent completes", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const llmCall = vi.fn()
      // First call: intent classification
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"intent": "general_chat", "confidence": 0.9}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Implemented." }] })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "RESULT: pass\nREASON: all criteria satisfied\nROOT_CAUSE: complete\nMISSING_CRITERIA: none\nFOLLOW_UP_TASK: none\nDISPOSITION: retry" }]
      });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({
        action: "run_task",
        event: { type: "message", text: "ship fix", channel: "C1" },
        orchestratorName: "slack-channel:C1",
        doName: "task-agent:C1:ok"
      })
    }));

    const completionBody = String((agentDOFetch.mock.calls.at(-1)?.[1] as RequestInit)?.body ?? "");
    expect(completionBody).toContain('"status":"completed"');
    // LLM calls: 1 for intent classification + 1 for task execution + 1 for planner audit
    expect(llmCall).toHaveBeenCalledTimes(3);
  });

  it("planner audit creates targeted follow-up and passes after retry", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const llmCall = vi.fn()
      // First call: intent classification
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"intent": "general_chat", "confidence": 0.9}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "First attempt output" }] })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "RESULT: fail\nREASON: missing tests\nROOT_CAUSE: implementation incomplete\nMISSING_CRITERIA: add regression test; verify alarm behavior\nFOLLOW_UP_TASK: Add regression tests for alarm behavior\nDISPOSITION: retry" }]
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Follow-up completed" }] })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "RESULT: pass\nREASON: complete\nROOT_CAUSE: fixed\nMISSING_CRITERIA: none\nFOLLOW_UP_TASK: none\nDISPOSITION: retry" }]
      })
      // Extra mocks in case intent classification is called again
      .mockResolvedValue({ content: [{ type: "text", text: '{"intent": "general_chat", "confidence": 0.9}' }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({
        action: "run_task",
        event: { type: "message", text: "ship fix", channel: "C1" },
        orchestratorName: "slack-channel:C1",
        doName: "task-agent:C1:retry"
      })
    }));

    const followUpPromptCall = llmCall.mock.calls.find((call: unknown[]) =>
      JSON.stringify(call[0]).includes("Add regression tests for alarm behavior")
    );
    expect(followUpPromptCall).toBeTruthy();
    const completionBody = String((agentDOFetch.mock.calls.at(-1)?.[1] as RequestInit)?.body ?? "");
    // With self-healing, the status is "failed" but a fix heartbeat is created
    expect(completionBody).toContain('"status":"failed"');
    expect(completionBody).toContain("Self-healing in progress");
  });

  it("planner audit stops at max attempts with diagnosed terminal failure", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);
    const llmCall = vi.fn()
      // First call: intent classification
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"intent": "general_chat", "confidence": 0.9}' }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Attempt 1" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "RESULT: fail\nREASON: gap 1\nROOT_CAUSE: rc1\nMISSING_CRITERIA: c1\nFOLLOW_UP_TASK: fix c1\nDISPOSITION: retry" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Attempt 2" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "RESULT: fail\nREASON: gap 2\nROOT_CAUSE: rc2\nMISSING_CRITERIA: c2\nFOLLOW_UP_TASK: fix c2\nDISPOSITION: retry" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Attempt 3" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "RESULT: fail\nREASON: gap 3\nROOT_CAUSE: rc3\nMISSING_CRITERIA: c3\nFOLLOW_UP_TASK: fix c3\nDISPOSITION: retry" }] })
      // Extra mocks for any additional calls
      .mockResolvedValue({ content: [{ type: "text", text: '{"intent": "general_chat", "confidence": 0.9}' }] });

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({
        action: "run_task",
        event: { type: "message", text: "ship fix", channel: "C1" },
        orchestratorName: "slack-channel:C1",
        doName: "task-agent:C1:max"
      })
    }));

    const completionBody = String((agentDOFetch.mock.calls.at(-1)?.[1] as RequestInit)?.body ?? "");
    expect(completionBody).toContain('"status":"failed"');
    expect(completionBody).toContain("Self-healing in progress");
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C1", expect.stringContaining("fixing it automatically"));
  });

  it("sub_agent_done action marks the sub-agent as completed", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();

    // Register a sub-agent first.
    sql.exec("INSERT OR IGNORE INTO sub_agents (channel, do_name) VALUES (?, ?)", "C1", "task-agent:C1:abc");

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const response = await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "sub_agent_done",
          doName: "task-agent:C1:abc",
          status: "completed"
        })
      })
    );

    expect(response.status).toBe(200);
  });

  it("reaction is broadcast to all active sub-agents for the channel", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();

    // Pre-register two active sub-agents for the channel.
    sql.exec("INSERT OR IGNORE INTO sub_agents (channel, do_name) VALUES (?, ?)", "C1", "task-agent:C1:agent1");
    sql.exec("INSERT OR IGNORE INTO sub_agents (channel, do_name) VALUES (?, ?)", "C1", "task-agent:C1:agent2");

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({
          action: "reaction",
          event: { type: "reaction_added", reaction: "thumbsup", item: { channel: "C1", ts: "ts1" } }
        })
      })
    );

    // Two broadcasts (one per active sub-agent) plus any global-logs calls.
    const reactionBroadcasts = agentDOFetch.mock.calls.filter((args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const body = typeof init?.body === "string" ? init.body : "";
      return body.includes('"action":"reaction"');
    });
    expect(reactionBroadcasts).toHaveLength(2);
  });

  it("multiple concurrent tasks each get their own sub-agent DO name", async () => {
    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ action: "message", event: { type: "message", text: "task one", channel: "C1" } })
      })
    );

    await agent.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ action: "message", event: { type: "message", text: "task two", channel: "C1" } })
      })
    );

    // Both tasks should have triggered sub-agent spawning.
    const spawnCalls = agentDOFetch.mock.calls.filter((args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const body = typeof init?.body === "string" ? init.body : "";
      return body.includes('"action":"run_task"');
    });
    expect(spawnCalls).toHaveLength(2);

    // Each spawn should reference a different sub-agent DO name.
    const doNames = spawnCalls.map((args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const parsed = JSON.parse(init?.body as string) as { doName: string };
      return parsed.doName;
    });
    expect(doNames[0]).not.toBe(doNames[1]);
  });
});

describe("AgentDO heartbeat actions", () => {
  it("enqueue_heartbeat action stores a heartbeat and schedules an alarm", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const now = 1_700_000_000_000;

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never,
      now: () => now
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
    expect(setAlarm).toHaveBeenCalledWith(now);
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

  it("empty queue with configured autonomous channel generates one task and schedules the next alarm", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const now = 1_700_000_000_000;

    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "autonomous_channel", "C-auto");

    const llmCall = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Improve test coverage for storage edge cases" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "DECISION: accept\nTASK:" }] });

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never,
      now: () => now
    });

    await agent.alarm();

    const listResp = await agent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list_heartbeats" })
    }));
    const listBody = await listResp.json() as { heartbeats: Array<{ task: string; channel: string }> };

    expect(listBody.heartbeats).toHaveLength(1);
    expect(listBody.heartbeats[0]).toMatchObject({
      task: "Improve test coverage for storage edge cases",
      channel: "C-auto"
    });
    expect(setAlarm).toHaveBeenCalledWith(now + 5 * 60 * 1000);
  });

  it("empty queue without autonomous channel or heartbeat history skips generation but still schedules next alarm", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const now = 1_700_000_000_000;
    const llmCall = vi.fn();

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never,
      now: () => now
    });

    await agent.alarm();

    expect(llmCall).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledWith(now + 5 * 60 * 1000);
  });

  it("non-empty queue executes heartbeat and still schedules next alarm", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const now = 1_700_000_000_000;
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Heartbeat done" }] }) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never,
      now: () => now
    });

    await agent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enqueue_heartbeat", task: "run health checks", channel: "C-hb" })
    }));

    setAlarm.mockClear();
    await agent.alarm();

    expect(postSlackMessage).toHaveBeenCalledWith("token", "C-hb", "Heartbeat done");
    expect(setAlarm).toHaveBeenCalledWith(now + 5 * 60 * 1000);
  });

  it("chat message like Hello remains chat-routed and does not enqueue heartbeat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ text: '{"type":"chat"}' }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Hi there!" }] }) as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ action: "message", event: { type: "message", text: "Hello", channel: "C-chat" } })
    }));

    const spawnCalls = agentDOFetch.mock.calls.filter((args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      return String(init?.body ?? "").includes('"action":"run_task"');
    });

    expect(spawnCalls).toHaveLength(0);
    expect(postSlackMessage).toHaveBeenCalledWith("token", "C-chat", "Hi there!");

    const logCalls = agentDOFetch.mock.calls.filter((args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      return String(init?.body ?? "").includes('"action":"log_event"');
    });
    expect(logCalls.length).toBeGreaterThan(0);
    const chatLogPayload = logCalls
      .map((args: unknown[]) => JSON.parse(String((args[1] as RequestInit | undefined)?.body ?? "")))
      .find((payload: { eventType?: string }) => payload.eventType === "chat_reply");
    expect(chatLogPayload).toBeDefined();
    expect(chatLogPayload.message).toContain("[#C-chat] Hi there!");

    vi.unstubAllGlobals();
  });

  it("detected routine and complex tasks still route to simple/complex task models", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ text: '{"type":"routine"}' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ text: '{"type":"complex"}' }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sql = new FakeSql();
    const { env, agentDOFetch } = makeTestEnv();
    const agent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.fetch(new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ action: "message", event: { type: "message", text: "fix lint", channel: "C1" } })
    }));
    await agent.fetch(new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ action: "message", event: { type: "message", text: "redesign architecture", channel: "C1" } })
    }));

    const runTaskCalls = agentDOFetch.mock.calls.filter((args: unknown[]) => String((args[1] as RequestInit | undefined)?.body ?? "").includes('"action":"run_task"'));
    const hints = runTaskCalls.map((args: unknown[]) => JSON.parse(String((args[1] as RequestInit | undefined)?.body ?? "")).taskComplexityHint);
    expect(hints).toEqual(["routine", "complex"]);
    vi.unstubAllGlobals();
  });


  it("uses planner models for autonomous planning and execution models for queued task runs", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "autonomous_channel", "C-auto");
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "model_planner_simple", "planner-simple-model");
    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "model_execution_simple", "execution-simple-model");

    const captured: Array<{ simpleModel?: string; toolsCount: number }> = [];
    const llmCall = vi.fn().mockImplementation(async (input: { simpleModel?: string; tools?: unknown[] }) => {
      captured.push({ simpleModel: input.simpleModel, toolsCount: input.tools?.length ?? 0 });
      if (captured.length === 1) return { content: [{ type: "text", text: "Write stronger alarm-loop tests" }] };
      if (captured.length === 2) return { content: [{ type: "text", text: "DECISION: accept\nTASK:" }] };
      return { content: [{ type: "text", text: "done" }] };
    });

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: vi.fn().mockResolvedValue(undefined) as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.alarm();
    await agent.alarm();

    expect(captured[0].simpleModel).toBe("planner-simple-model");
    expect(captured[1].simpleModel).toBe("planner-simple-model");
    expect(captured[2].simpleModel).toBe("execution-simple-model");
    expect(captured[2].toolsCount).toBeGreaterThan(0);
  });

  it("applies operator feedback to subsequent autonomous planning", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const postSlackMessage = vi.fn().mockResolvedValue(undefined);

    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "autonomous_channel", "C-auto");

    const llmCall = vi.fn().mockImplementation(async (input: { messages: Array<{ content: string }> }) => {
      const prompt = input.messages[0]?.content ?? "";
      if (prompt.includes("Latest operator steering feedback") && prompt.includes("Prioritize reliability work")) {
        return { content: [{ type: "text", text: "Improve reliability alerting coverage" }] };
      }
      return { content: [{ type: "text", text: "DECISION: accept\nTASK:" }] };
    });

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: llmCall as never,
      postSlackMessage: postSlackMessage as never,
      postSlackApproval: vi.fn() as never
    });

    const feedbackResp = await agent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submit_feedback", feedback: "Prioritize reliability work", channel: "C-auto" })
    }));

    expect(feedbackResp.status).toBe(200);
    await agent.alarm();

    const listResp = await agent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list_heartbeats" })
    }));

    const tasks = ((await listResp.json()) as { heartbeats: Array<{ task: string }> }).heartbeats.map((h) => h.task);
    expect(tasks).toContain("Improve reliability alerting coverage");
    expect(postSlackMessage).toHaveBeenCalledWith(
      "token",
      "C-auto",
      expect.stringContaining("Feedback recorded")
    );
  });

  it("duplicate prevention rejects exact/semantic near-duplicates and does not rely on regex-only matching", async () => {
    const sql = new FakeSql();
    const { env } = makeTestEnv();
    const setAlarm = vi.fn().mockResolvedValue(undefined);

    sql.exec("INSERT INTO settings (key, value) VALUES (?, ?)", "autonomous_channel", "C-auto");
    const responses: Array<{ content: Array<{ type: string; text: string }> }> = [
      { content: [{ type: "text", text: "Refactor approval flow tests" }] },
      { content: [{ type: "text", text: "DECISION: accept\nTASK:" }] },
      { content: [{ type: "text", text: "Completed heartbeat task" }] },
      { content: [{ type: "text", text: "Refactor approval flow tests" }] },
      { content: [{ type: "text", text: "DECISION: reject\nTASK:" }] },
      { content: [{ type: "text", text: "Harden heartbeat resume logic" }] },
      { content: [{ type: "text", text: "DECISION: rewrite\nTASK: Validate heartbeat resume under alarm drift" }] }
    ];

    const agent = new AgentDO({ storage: { sql, setAlarm } }, env, {
      llmCall: vi.fn().mockImplementation(async () => responses.shift() ?? { content: [{ type: "text", text: "skip" }] }) as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    await agent.alarm();
    await agent.alarm();
    await agent.alarm();
    await agent.alarm();

    const listAgent = new AgentDO({ storage: { sql } }, env, {
      llmCall: vi.fn() as never,
      postSlackMessage: vi.fn() as never,
      postSlackApproval: vi.fn() as never
    });

    const listResp = await listAgent.fetch(new Request("https://agent.internal/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list_heartbeats" })
    }));

    const tasks = ((await listResp.json()) as { heartbeats: Array<{ task: string }> }).heartbeats.map((h) => h.task);
    expect(tasks).toContain("Refactor approval flow tests");
    expect(tasks).toContain("Validate heartbeat resume under alarm drift");
    expect(tasks.filter((task) => task === "Refactor approval flow tests")).toHaveLength(1);
    expect(tasks).not.toContain("Harden heartbeat resume logic");
  });
});


describe("parseSessionMemoryUpdate", () => {
  it("parses valid JSON memory update payload", () => {
    const parsed = parseSessionMemoryUpdate(JSON.stringify({
      summary: "Updated response style preference.",
      updated_agent_md: "- Keep responses brief",
      changes_made: true
    }));

    expect(parsed).toEqual({
      summary: "Updated response style preference.",
      updatedAgentMd: "- Keep responses brief",
      changesMade: true
    });
  });

  it("rejects non-JSON and empty summary payloads", () => {
    expect(parseSessionMemoryUpdate("SUMMARY: hi")).toBeNull();
    expect(parseSessionMemoryUpdate(JSON.stringify({ updated_agent_md: "(unchanged)" }))).toBeNull();
  });

  it("defaults updatedAgentMd and changesMade when omitted", () => {
    const parsed = parseSessionMemoryUpdate(JSON.stringify({
      summary: "No durable memory changes."
    }));

    expect(parsed).toEqual({
      summary: "No durable memory changes.",
      updatedAgentMd: "(unchanged)",
      changesMade: false
    });
  });
});
