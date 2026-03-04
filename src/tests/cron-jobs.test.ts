import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCronAlert,
  detectCronAlerts,
  dispatchCronTask,
  postCronAlertWithFallback,
  runCronTask,
  type CronOutcomeRecord,
} from "../cron-jobs";
import type { Env } from "../types";

class FakeObject {
  constructor(private body: string) {}
  async text(): Promise<string> { return this.body; }
  async json(): Promise<unknown> { return JSON.parse(this.body); }
}

class FakeR2Bucket {
  store = new Map<string, string>();
  async get(key: string): Promise<FakeObject | null> {
    const value = this.store.get(key);
    return value === undefined ? null : new FakeObject(value);
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(opts?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }> {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return { objects: keys.map((key) => ({ key })) };
  }
}

function makeEnv(): Env {
  const bucket = new FakeR2Bucket() as unknown as R2Bucket;
  let outcomeCalls = 0;
  const doStub = {
    fetch: async () => {
      outcomeCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  } as DurableObjectStub;

  return {
    AGENT_DO: {
      idFromName: () => "blob-id" as DurableObjectId,
      get: () => doStub,
    } as DurableObjectNamespace,
    SANDBOX: {
      start: async () => undefined,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async () => undefined,
      readFile: async () => "",
    },
    REPO_STORE: bucket,
    PI_VECTORS: {
      query: async () => ({ matches: [] }),
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
    } as unknown as VectorizeIndex,
    __outcomeCalls: () => outcomeCalls,
  } as Env & { __outcomeCalls: () => number };
}

test("dispatchCronTask routes configured cron expression", async () => {
  const env = makeEnv();
  const result = await dispatchCronTask("30 */6 * * *", env);
  assert.equal(result?.jobName, "memory-reconciliation");
});

test("runCronTask starts sandbox and records cron outcome", async () => {
  let started = false;
  const env = makeEnv() as Env & { __outcomeCalls: () => number };
  env.SANDBOX.start = async () => { started = true; };

  const result = await runCronTask("memory-reconciliation", env);
  assert.equal(started, true);
  assert.equal(result.status, "success");
  assert.equal(env.__outcomeCalls(), 1);
});

test("detectCronAlerts catches threshold and stall conditions", () => {
  const now = Date.now();
  const outcomes: Record<string, CronOutcomeRecord> = {
    "content-scan": {
      jobName: "content-scan",
      status: "failure",
      lastRunAt: now - (31 * 60 * 1000),
      consecutiveFailures: 3,
      lastError: "boom",
    },
  };

  const alerts = detectCronAlerts(outcomes, now, { failThreshold: 3, stallMultiplier: 2 });
  assert.equal(alerts.length, 1);
});

test("buildCronAlert includes required payload fields", () => {
  const text = buildCronAlert(
    {
      jobName: "content-scan",
      status: "failure",
      durationMs: 100,
      outputSummary: "failed",
      lastError: "network",
      sessionId: "s1",
    },
    { jobName: "content-scan", status: "failure", lastRunAt: Date.now(), consecutiveFailures: 3, lastSuccessAt: Date.now() - 1000 }
  );
  assert.match(text, /Cron alert: content-scan/);
  assert.match(text, /Last error:/);
  assert.match(text, /Last success:/);
  assert.match(text, /Suggested action:/);
});

test("postCronAlertWithFallback writes to R2 when Slack post fails", async () => {
  const env = makeEnv();
  env.SLACK_BOT_TOKEN = "x";
  env.SLACK_SUMMARY_CHANNEL = "C123";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

  try {
    const result = await postCronAlertWithFallback(env, "alert text");
    assert.equal(result, "r2");
    const keys = await env.REPO_STORE.list({ prefix: "alerts/" });
    assert.equal(keys.objects.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
