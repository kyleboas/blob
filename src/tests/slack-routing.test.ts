import test from "node:test";
import assert from "node:assert/strict";
import { deriveRoutingKey, verifySlackSignature } from "../integrations/slack-routing";

async function buildSignedRequest(secret: string, payload: unknown, ts: number): Promise<Request> {
  const body = JSON.stringify(payload);
  const base = `v0:${ts}:${body}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const sig = `v0=${Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": sig,
    },
    body,
  });
}

test("deriveRoutingKey handles thread/top-level/dm patterns", () => {
  assert.equal(
    deriveRoutingKey({ team_id: "T1", event: { channel: "C1", thread_ts: "170.01" } }),
    "T1:C1:170.01",
  );
  assert.equal(
    deriveRoutingKey({ team_id: "T1", event: { channel: "C1" } }),
    "T1:C1:channel",
  );
  assert.equal(
    deriveRoutingKey({ team_id: "T1", event: { channel: "D1", channel_type: "im", user: "U1" } }),
    "T1:U1:dm",
  );
});

test("verifySlackSignature accepts valid signatures", async () => {
  const now = Math.floor(Date.now() / 1000);
  const req = await buildSignedRequest("secret", { type: "event_callback" }, now);
  const valid = await verifySlackSignature(req, "secret", now);
  assert.equal(valid, true);
});

test("verifySlackSignature rejects stale request timestamps", async () => {
  const now = Math.floor(Date.now() / 1000);
  const req = await buildSignedRequest("secret", { type: "event_callback" }, now - 4000);
  const valid = await verifySlackSignature(req, "secret", now);
  assert.equal(valid, false);
});
