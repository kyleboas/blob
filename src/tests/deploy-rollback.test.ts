import test from "node:test";
import assert from "node:assert/strict";
import { monitorPostDeploy, rollback } from "../agent/deploy-rollback";
import type { Env } from "../core/types";

function envWithFailures(failures: number): Env {
  const doStub = {
    fetch: async () => new Response(JSON.stringify({ consecutiveHeartbeatFailures: failures }), { headers: { "content-type": "application/json" } }),
  } as DurableObjectStub;

  return {
    AGENT_DO: {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => doStub,
    },
    SANDBOX: {} as Env["SANDBOX"],
    REPO_STORE: {} as R2Bucket,
    CLOUDFLARE_API_TOKEN: "token",
    ACCOUNT_ID: "acct",
    WORKER_NAME: "blob-worker",
    SLACK_BOT_TOKEN: "x",
    SLACK_SUMMARY_CHANNEL: "C1",
  } as unknown as Env;
}

test("monitorPostDeploy reports healthy/unhealthy", async () => {
  assert.equal(await monitorPostDeploy(envWithFailures(0), 3), "healthy");
  assert.equal(await monitorPostDeploy(envWithFailures(3), 3), "unhealthy");
});

test("rollback calls cloudflare api and posts alert", async () => {
  const env = envWithFailures(3);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await rollback(env);
    assert.ok(calls.some((u) => u.includes("/rollback")));
    assert.ok(calls.some((u) => u.includes("chat.postMessage")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
