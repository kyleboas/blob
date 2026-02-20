import { describe, expect, it, vi } from "vitest";
import {
  mapChannelToDO,
  parseSlackEvent,
  postApprovalRequest,
  postMessage,
  verifySlackSignature
} from "./slack";

async function makeSlackSignedRequest(body: string, signingSecret: string, timestamp?: number): Promise<Request> {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const base = `v0:${ts}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const sig = `v0=${Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig
    },
    body
  });
}

describe("verifySlackSignature", () => {
  it("accepts valid signatures", async () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const req = await makeSlackSignedRequest(body, "secret");

    await expect(verifySlackSignature(req, "secret")).resolves.toBe(true);
  });

  it("rejects invalid signatures", async () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const req = await makeSlackSignedRequest(body, "secret");

    await expect(verifySlackSignature(req, "wrong"))
      .resolves.toBe(false);
  });

  it("rejects expired signatures", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 700;
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const req = await makeSlackSignedRequest(body, "secret", oldTimestamp);

    await expect(verifySlackSignature(req, "secret")).resolves.toBe(false);
  });
});

describe("parseSlackEvent", () => {
  it("parses url verification challenges", () => {
    const parsed = parseSlackEvent(JSON.stringify({ type: "url_verification", challenge: "abc" }));
    expect(parsed).toEqual({ type: "url_verification", challenge: "abc" });
  });

  it("parses message event callbacks", () => {
    const parsed = parseSlackEvent(
      JSON.stringify({
        type: "event_callback",
        event: { type: "message", channel: "C1", text: "hello", ts: "1.1" }
      })
    );

    expect(parsed.type).toBe("event_callback");
    expect(parsed.event?.type).toBe("message");
  });

  it("parses reaction events", () => {
    const parsed = parseSlackEvent(
      JSON.stringify({
        type: "event_callback",
        event: { type: "reaction_added", reaction: "+1", item: { ts: "123.4" } }
      })
    );

    expect(parsed.event?.type).toBe("reaction_added");
  });
});

describe("posting helpers", () => {
  it("posts messages to chat.postMessage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "123.4" }), { status: 200 })
    );

    await postMessage("xoxb-token", "C123", "hello", "123.4", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("chat.postMessage");
    expect(String(init.headers)).toContain("Bearer xoxb-token");
  });

  it("posts approval request text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "123.4" }), { status: 200 })
    );

    await postApprovalRequest("xoxb-token", "C123", "Run rm -rf?", fetchImpl);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(body.text).toContain("Approval required");
    expect(body.text).toContain("thumbsup");
  });
});

describe("mapChannelToDO", () => {
  it("is deterministic for the same channel", () => {
    expect(mapChannelToDO("C1")).toBe(mapChannelToDO("C1"));
  });
});
