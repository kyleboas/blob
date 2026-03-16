import test from "node:test";
import assert from "node:assert/strict";
import { handleSlackEvent } from "../integrations/slack";

function makeEnv() {
  return {
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ processed: false, messages: [] }), { headers: { "content-type": "application/json" } }),
      }),
    },
  } as any;
}

test("handleSlackEvent acknowledges event_callback immediately when execution context is provided", async () => {
  const request = new Request("https://example.com/slack/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "event_callback",
      event_id: "E123",
      team_id: "T1",
      event: { type: "message", text: "hi", channel: "C1", ts: "1.2" },
    }),
  });

  let waitUntilCalled = false;
  let doFetchCalled = false;
  let releaseDoFetch: (() => void) | undefined;
  let doFetchCompleted = false;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilCalled = true;
      void promise.then(() => {
        doFetchCompleted = true;
      });
    },
  } as any;

  const env = {
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          doFetchCalled = true;
          await new Promise<void>((resolve) => {
            releaseDoFetch = resolve;
          });
          return new Response(JSON.stringify({ processed: false, messages: [] }), { headers: { "content-type": "application/json" } });
        },
      }),
    },
  } as any;

  const res = await handleSlackEvent(request, env, ctx);
  assert.equal(res.status, 200);
  assert.equal(doFetchCalled, true);
  assert.equal(waitUntilCalled, true);
  assert.equal(doFetchCompleted, false);
  releaseDoFetch?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(doFetchCompleted, true);
});
