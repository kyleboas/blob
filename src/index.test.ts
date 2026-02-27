import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

interface DurableObjectStubLike {
  fetch: ReturnType<typeof vi.fn>;
}

function makeSignature(timestamp: string, body: string, secret: string): Promise<string> {
  const base = `v0:${timestamp}:${body}`;
  return crypto.subtle
    .importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((key) => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)))
    .then((sig) => `v0=${Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
}

function makeEnv(stub: DurableObjectStubLike, overrides: Partial<Env> = {}): Env {
  return {
    AGENT_DO: {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => stub)
    } as unknown as DurableObjectNamespace,
    REPO_STORE: {} as R2Bucket,
    SANDBOX: {} as Fetcher,
    ANTHROPIC_API_KEY: "key",
    SLACK_BOT_TOKEN: "token",
    SLACK_SIGNING_SECRET: "signing-secret",
    ...overrides
  };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {
        return;
      }
    } as ExecutionContext
  };
}

async function signedRequest(body: string, secret: string): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await makeSignature(timestamp, body, secret);

  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      "content-type": "application/json"
    },
    body
  });
}

describe("worker entry point", () => {
  it("responds to health checks", async () => {
    const stub = { fetch: vi.fn() };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(new Request("https://example.com/health"), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("rejects invalid Slack signatures", async () => {
    const stub = { fetch: vi.fn() };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(
      new Request("https://example.com/slack/events", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=invalid"
        },
        body: JSON.stringify({ type: "url_verification", challenge: "abc" })
      }),
      env,
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns the Slack challenge for url verification", async () => {
    const stub = { fetch: vi.fn() };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-token" });

    const response = await worker.fetch(await signedRequest(body, env.SLACK_SIGNING_SECRET), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-token" });
  });

  it("forwards message events to the thread Durable Object", async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const env = makeEnv(stub);
    const { ctx, pending } = makeCtx();

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C1",
        text: "run ls",
        thread_ts: "1711111111.2222"
      }
    };

    const response = await worker.fetch(
      await signedRequest(JSON.stringify(payload), env.SLACK_SIGNING_SECRET),
      env,
      ctx
    );
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(2);
    const forwardedBody = JSON.parse(stub.fetch.mock.calls[0][1].body as string);
    const mirroredBody = JSON.parse(stub.fetch.mock.calls[1][1].body as string);
    expect(forwardedBody.action).toBe("message");
    expect(mirroredBody.action).toBe("logs_mirror");
  });

  it("ignores bot messages to prevent infinite loops", async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const env = makeEnv(stub);
    const { ctx, pending } = makeCtx();

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        bot_id: "B123",
        channel: "C1",
        text: "I am a bot response",
        ts: "1711111111.5555"
      }
    };

    const response = await worker.fetch(
      await signedRequest(JSON.stringify(payload), env.SLACK_SIGNING_SECRET),
      env,
      ctx
    );
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("ignores message subtype events like message_changed", async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const env = makeEnv(stub);
    const { ctx, pending } = makeCtx();

    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "1711111111.6666"
      }
    };

    const response = await worker.fetch(
      await signedRequest(JSON.stringify(payload), env.SLACK_SIGNING_SECRET),
      env,
      ctx
    );
    await Promise.all(pending);

    expect(response.status).toBe(200);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("forwards reaction events to resolve approvals", async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const env = makeEnv(stub);
    const { ctx, pending } = makeCtx();

    const payload = {
      type: "event_callback",
      event: {
        type: "reaction_added",
        reaction: "thumbsup",
        item: { ts: "1711111111.3333", channel: "C1" }
      }
    };

    await worker.fetch(await signedRequest(JSON.stringify(payload), env.SLACK_SIGNING_SECRET), env, ctx);
    await Promise.all(pending);

    expect(stub.fetch).toHaveBeenCalledTimes(2);
    const forwardedBody = JSON.parse(stub.fetch.mock.calls[0][1].body as string);
    const mirroredBody = JSON.parse(stub.fetch.mock.calls[1][1].body as string);
    expect(forwardedBody.action).toBe("reaction");
    expect(mirroredBody.action).toBe("logs_mirror");
  });


  it("serves the live logs page at the root path", async () => {
    const stub = { fetch: vi.fn() };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(new Request("https://example.com/"), env, ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Blob Live Logs");
  });

  it("renders the live logs shell without manual channel controls", async () => {
    const stub = { fetch: vi.fn() };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(new Request("https://example.com/logs"), env, ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Live across all channels");
    expect(html).not.toContain("channel-input");
  });



  it("renders the live logs shell with real-time stream support", async () => {
    const stub = { fetch: vi.fn() };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(new Request("https://example.com/logs"), env, ctx);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("/logs/stream");
    expect(html).toContain("class=\"line\"");
    expect(html).toContain("Polling logs");
    expect(html).not.toContain("stale stream");
  });


  it("serves a JSON endpoint for live log streaming (polling)", async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(Response.json({ events: [] })) };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(new Request("https://example.com/logs/stream"), env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("proxies live log data from the global stream", async () => {
    const stub = { fetch: vi.fn().mockResolvedValue(Response.json({ events: [{ eventType: "thinking", message: "Started", createdAt: 1700000000 }] })) };
    const env = makeEnv(stub);
    const { ctx } = makeCtx();

    const response = await worker.fetch(new Request("https://example.com/logs/data"), env, ctx);

    expect(response.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    const forwardedBody = JSON.parse(stub.fetch.mock.calls[0][1].body as string);
    expect(forwardedBody.action).toBe("logs_snapshot");
  });

});
