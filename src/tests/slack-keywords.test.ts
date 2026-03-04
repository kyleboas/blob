import test from "node:test";
import assert from "node:assert/strict";
import { handleSlackEvent } from "../integrations/slack";

type Verbosity = "minimal" | "verbose";

function makeEnv() {
  const store = new Map<string, { verbosity: Verbosity; messages: Array<{ role: string; content: string; timestamp: number }> }>();
  const posts: string[] = [];

  const ensure = (id: string) => {
    if (!store.has(id)) {
      store.set(id, { verbosity: "minimal", messages: [] });
    }
    return store.get(id)!;
  };

  const env = {
    SLACK_BOT_TOKEN: "x-test",
    AI: {
      run: async (_model: string, inputs: { messages: Array<{ role: string; content: string }> }) => {
        const user = inputs.messages.find((m) => m.role === "user")?.content ?? "";
        if (user.includes('Message: "status please"')) {
          return { response: '{"intent":"chat","needsSandbox":false}' };
        }
        if (user.includes("intent classifier")) {
          return { response: '{"intent":"chat","needsSandbox":false}' };
        }
        return { response: "normal chat response" };
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
            return Response.json({ lastFlushAt: "2026-01-01T00:00:00.000Z", lastFlushCount: 3 });
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
