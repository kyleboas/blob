import test from "node:test";
import assert from "node:assert/strict";
import { handleSlackEvent } from "../integrations/slack";

type Verbosity = "minimal" | "verbose";

function makeEnv() {
  const store = new Map<string, { verbosity: Verbosity; messages: Array<{ role: string; content: string; timestamp: number }> }>();
  const posts: string[] = [];
  const files = new Map<string, string>();
  const r2 = new Map<string, string>();
  const vectors = new Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>();
  files.set("/workspace/blob/README.md", "# Blob\n");

  const ensure = (id: string) => {
    if (!store.has(id)) {
      store.set(id, { verbosity: "minimal", messages: [] });
    }
    return store.get(id)!;
  };

  const env = {
    SLACK_BOT_TOKEN: "x-test",
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command.includes("node -v")) {
          return { stdout: "v20.11.1\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
    },
    REPO_STORE: {
      put: async (key: string, value: string) => {
        r2.set(key, value);
      },
      get: async (key: string) => {
        const val = r2.get(key);
        return val === undefined ? null : { text: async () => val };
      },
    },
    PI_VECTORS: {
      upsert: async (rows: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => {
        for (const row of rows) vectors.set(row.id, row);
      },
      query: async (_vec: number[], opts?: { filter?: Record<string, unknown>; topK?: number }) => {
        const scope = opts?.filter?.conversationKey;
        const matches = [...vectors.values()]
          .filter((row) => !scope || row.metadata?.conversationKey === scope)
          .slice(0, opts?.topK ?? 5)
          .map((row) => ({ id: row.id, score: 0.9, metadata: row.metadata }));
        return { matches };
      },
    },
    AI: {
      run: async (_model: string, inputs: { messages?: Array<{ role: string; content: string }>; text?: string }) => {
        if (inputs.messages) {
          const user = inputs.messages.find((m) => m.role === "user")?.content ?? "";
          if (user.includes('Message: "status please"')) {
            return { response: '{"intent":"chat","needsSandbox":false}' };
          }
          if (user.includes("intent classifier")) {
            return { response: '{"intent":"chat","needsSandbox":false}' };
          }
          return { response: "normal chat response" };
        }
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          const row = ensure(id);
          if (path === "/events/check") {
            return Response.json({ processed: false });
          }
          if (path === "/repos") {
            return Response.json({ repos: ["owner/blob"] });
          }
          if (path === "/settings/verbosity" && (!init || init.method === "GET")) {
            return Response.json({ verbosity: row.verbosity });
          }
          if (path === "/settings/verbosity" && init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as { verbosity: Verbosity };
            row.verbosity = body.verbosity;
            return Response.json({ saved: true, verbosity: row.verbosity });
          }
          if (path === "/messages" && init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as { role: string; content: string };
            row.messages.push({ ...body, timestamp: Date.now() });
            return Response.json({ saved: true });
          }
          if (path === "/messages") {
            return Response.json({ messages: row.messages.slice(-20) });
          }
          if (path === "/memory/learned/status") {
            return init?.method === "POST"
              ? Response.json({ saved: true })
              : Response.json({ lastFlushAt: "2026-01-01T00:00:00.000Z", lastFlushCount: 3 });
          }
          if (path === "/memory/vectorize/status") {
            return init?.method === "POST"
              ? Response.json({ saved: true })
              : Response.json({ lastUpsertAt: null, lastUpsertOk: null, lastUpsertError: null, lastQueryAt: null, lastQueryCount: 0 });
          }
          if (path === "/heartbeat/status") {
            return Response.json({
              nextAlarmAt: "2026-01-01T00:10:00.000Z",
              lastCompletedAt: "2026-01-01T00:00:00.000Z",
              callsRemaining: 4,
              jobs: { queued: 1, paused: 0, running: 2 },
            });
          }
          if (path === "/daily-tokens" && init?.method === "POST") {
            return Response.json({ totalTokens: 1 });
          }
          if (path === "/process-message" && init?.method === "POST") {
            const { processSlackMessage } = await import("../integrations/slack-message-processing-mock");
            const body = JSON.parse(String(init.body));
            await processSlackMessage(body, env);
            return new Response("OK");
          }
          return new Response("not found", { status: 404 });
        },
      }),
    },
  } as any;

  return { env, posts, store };
}

test("settings and set verbose commands are exact keywords and persist verbosity", async () => {
  const { env, posts, store } = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      posts.push(body.text);
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const makeReq = (text: string) => new Request("https://example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        event_id: crypto.randomUUID(),
        team_id: "T1",
        event: { type: "message", text, channel: "C1", ts: `${Date.now()}` },
      }),
    });

    await handleSlackEvent(makeReq("settings"), env);
    await handleSlackEvent(makeReq("set verbose"), env);
    await handleSlackEvent(makeReq("settings"), env);
    await handleSlackEvent(makeReq("status"), env);

    assert.match(posts[0], /Current mode: minimal/i);
    assert.match(posts[1], /verbosity is now verbose/i);
    assert.match(posts[2], /Current mode: verbose/i);
    assert.match(posts[3], /Heartbeat last run: 2026-01-01T00:00:00.000Z/i);
    assert.match(posts[3], /Heartbeat jobs queued\/paused\/running: 1\/0\/2/i);
    assert.match(posts[3], /Learned memory last flush: 2026-01-01T00:00:00.000Z/i);
    assert.match(posts[3], /Learned entries in last flush: 3/i);
    const key = "T1:C1:channel";
    assert.equal(store.get(key)?.verbosity, "verbose");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status with extra text is treated as normal chat", async () => {
  const { env, posts } = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      posts.push(body.text);
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const req = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        event_id: "E-extra",
        team_id: "T1",
        event: { type: "message", text: "status please", channel: "C1", ts: "2" },
      }),
    });

    await handleSlackEvent(req, env);
    assert.equal(posts[0], "normal chat response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sandbox chat still posts a fallback Slack message when agent final text is empty", async () => {
  const { env, posts } = makeEnv();
  env.AI.run = async (_model: string, inputs: { messages?: Array<{ role: string; content: string }>; text?: string }) => {
    if (inputs.messages) {
      const user = inputs.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.includes("intent classifier")) {
        return { response: '{"intent":"chat","needsSandbox":true}' };
      }
      return { response: "" };
    }
    return { data: [[0.1, 0.2, 0.3]] };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      posts.push(body.text);
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const req = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        event_id: "E-sandbox-empty",
        team_id: "T1",
        event: { type: "message", text: "please run a tool", channel: "C1", ts: "8" },
      }),
    });

    await handleSlackEvent(req, env);
    assert.equal(posts[0], "Working…");
    assert.equal(posts[1], "(No textual response generated. Please check logs/tool output.)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selftest command runs full workflow and posts result", async () => {
  const { env, posts } = makeEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      posts.push(body.text);
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const req = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        event_id: "E-selftest",
        team_id: "T1",
        event: { type: "message", text: "selftest", channel: "C1", ts: "3" },
      }),
    });

    await handleSlackEvent(req, env);
    assert.equal(posts[0], "Running self-test…");
    assert.match(posts[1], /Self-test passed/i);
    assert.match(posts[1], /bootstrap, tools, and R2 are healthy/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("chat requests are paused when runtime controls file sets paused", async () => {
  const { env, posts } = makeEnv();
  await env.REPO_STORE.put("config/runtime-controls.json", JSON.stringify({ paused: true, reason: "maintenance window" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      posts.push(body.text);
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const req = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        event_id: "E-paused",
        team_id: "T1",
        event: { type: "message", text: "fix this bug", channel: "C1", ts: "4" },
      }),
    });

    await handleSlackEvent(req, env);
    assert.match(posts[0], /Blob is currently paused/i);
    assert.match(posts[0], /maintenance window/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
