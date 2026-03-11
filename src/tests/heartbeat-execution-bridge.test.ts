/**
 * Tests for the heartbeat → PiAgent execution bridge.
 *
 * These tests verify that runHeartbeatAlarm correctly:
 *   1. Marks queued/paused jobs as "running" before dispatching them.
 *   2. Dispatches each job to PiAgent.run() via state.waitUntil (non-blocking).
 *   3. Marks jobs as "completed" on success or "failed" on error.
 *   4. Skips jobs whose estimatedCalls exceed the remaining budget.
 *   5. Force-pauses jobs that have exceeded the maximum duration.
 *   6. Does not re-dispatch a job that is already "running" (concurrency guard).
 *   7. Uses current_step as the prompt for paused/resumed jobs.
 *   8. Falls back to repo goals when current_step is empty (fresh queued job).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runHeartbeatAlarm } from "../agent/do-alarm";
import type { BlobState } from "../agent/do";
import type { Env } from "../core/types";

// ---------------------------------------------------------------------------
// Minimal fake SQL store that tracks job rows in memory.
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  status: string;
  created_at: number;
  updated_at: number;
  current_step: string;
  tool_history: string;
  partial_outputs: string;
  sandbox_id: string | null;
  token_usage: number;
  model_call_count: number;
  estimated_calls: number;
};

class FakeRows {
  constructor(private readonly rows: Record<string, unknown>[]) {}
  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.rows[Symbol.iterator]();
  }
  toArray(): Record<string, unknown>[] {
    return [...this.rows];
  }
  one(): Record<string, unknown> | null {
    return this.rows[0] ?? null;
  }
}

function createJobStore(initialJobs: JobRow[] = []) {
  const jobs = new Map<string, JobRow>();
  for (const job of initialJobs) {
    jobs.set(job.id, { ...job });
  }

  const exec = (query: string, ...args: unknown[]): FakeRows => {
    // SELECT pending jobs (the main dispatch query)
    if (query.includes("WHERE status IN ('queued', 'paused')")) {
      const rows = [...jobs.values()].filter(
        (j) => j.status === "queued" || j.status === "paused",
      );
      return new FakeRows(rows as unknown as Record<string, unknown>[]);
    }
    // UPDATE status='running'
    if (query.startsWith("UPDATE jobs SET status='running'")) {
      const [updatedAt, id] = args as [number, string];
      const job = jobs.get(String(id));
      if (job) {
        job.status = "running";
        job.updated_at = updatedAt;
        job.model_call_count += 1;
        jobs.set(String(id), job);
      }
      return new FakeRows([]);
    }
    // UPDATE status='paused' (force-pause)
    if (query.startsWith("UPDATE jobs SET status='paused'")) {
      const [updatedAt, id] = args as [number, string];
      const job = jobs.get(String(id));
      if (job) {
        job.status = "paused";
        job.updated_at = updatedAt;
        jobs.set(String(id), job);
      }
      return new FakeRows([]);
    }
    // UPDATE status='completed'
    if (query.startsWith("UPDATE jobs SET status='completed'")) {
      const [updatedAt, id] = args as [number, string];
      const job = jobs.get(String(id));
      if (job) {
        job.status = "completed";
        job.updated_at = updatedAt;
        jobs.set(String(id), job);
      }
      return new FakeRows([]);
    }
    // UPDATE status='failed'
    if (query.startsWith("UPDATE jobs SET status='failed'")) {
      const [updatedAt, id] = args as [number, string];
      const job = jobs.get(String(id));
      if (job) {
        job.status = "failed";
        job.updated_at = updatedAt;
        jobs.set(String(id), job);
      }
      return new FakeRows([]);
    }
    // SELECT service_secrets (used by getSecretsForInjection)
    if (query.includes("service_secrets")) {
      return new FakeRows([]);
    }
    // Any other query — return empty rows rather than throwing.
    return new FakeRows([]);
  };

  return { exec, jobs };
}

// ---------------------------------------------------------------------------
// Fake DurableObjectState with a controllable waitUntil that resolves promises.
// ---------------------------------------------------------------------------

function createState(store: ReturnType<typeof createJobStore>) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const state = {
    storage: {
      sql: store,
      setAlarm: async (_at: number) => undefined,
      getAlarm: async () => null,
    },
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
  } as unknown as DurableObjectState;
  return { state, waitUntilPromises };
}

// ---------------------------------------------------------------------------
// Minimal Env with a stubbed fetch (used by plan() and logEvent).
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AGENT_DO: {} as DurableObjectNamespace,
    SANDBOX: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async () => undefined,
      readFile: async () => "",
    } as unknown as Env["SANDBOX"],
    REPO_STORE: {} as R2Bucket,
    HEARTBEAT_INTERVAL_MS: "1000",
    HEARTBEAT_BACKOFF_THRESHOLD: "3",
    AI_GATEWAY_BASE_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "test-token",
    ...overrides,
  } as Env;
}

// ---------------------------------------------------------------------------
// Helper: flush all waitUntil promises so we can assert on final job status.
// ---------------------------------------------------------------------------

async function flushWaitUntil(promises: Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(promises);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("bridge marks queued job as running then completed on success", async () => {
  const store = createJobStore([
    {
      id: "job-1",
      status: "queued",
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      current_step: "fix the bug in src/core/types.ts",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 1,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  // Stub globalThis.fetch so PiAgent.run() gets a valid LLM response.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "Done.", tool_calls: [] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    await runHeartbeatAlarm(state, makeEnv(), data, async () => undefined);

    // After the synchronous part of runHeartbeatAlarm, the job should be "running".
    assert.equal(store.jobs.get("job-1")?.status, "running", "job should be marked running synchronously");

    // Flush async work (agent execution).
    await flushWaitUntil(waitUntilPromises);

    assert.equal(store.jobs.get("job-1")?.status, "completed", "job should be completed after agent finishes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge marks job as failed when PiAgent.run throws", async () => {
  const store = createJobStore([
    {
      id: "job-fail",
      status: "queued",
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      current_step: "do something",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 1,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  // Stub fetch to simulate an LLM error.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

  try {
    await runHeartbeatAlarm(state, makeEnv(), data, async () => undefined);
    assert.equal(store.jobs.get("job-fail")?.status, "running");

    await flushWaitUntil(waitUntilPromises);

    assert.equal(store.jobs.get("job-fail")?.status, "failed", "job should be failed after agent throws");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge skips jobs whose estimatedCalls exceed remaining budget", async () => {
  const store = createJobStore([
    {
      id: "big-job",
      status: "queued",
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      current_step: "refactor everything",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 99, // exceeds any reasonable budget
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  await runHeartbeatAlarm(state, makeEnv({ HEARTBEAT_MODEL_CALL_LIMIT: "5" }), data, async () => undefined);
  await flushWaitUntil(waitUntilPromises);

  // Job should still be queued — it was skipped, not dispatched.
  assert.equal(store.jobs.get("big-job")?.status, "queued", "oversized job should remain queued");
});

test("bridge force-pauses jobs that exceed maximum duration", async () => {
  const store = createJobStore([
    {
      id: "old-job",
      status: "queued",
      // Created more than 30 minutes ago — shouldForcePause returns true.
      created_at: Date.now() - 31 * 60 * 1000,
      updated_at: Date.now() - 31 * 60 * 1000,
      current_step: "",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 1,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  await runHeartbeatAlarm(state, makeEnv(), data, async () => undefined);
  await flushWaitUntil(waitUntilPromises);

  assert.equal(store.jobs.get("old-job")?.status, "paused", "stale job should be force-paused");
});

test("bridge does not dispatch already-running jobs (concurrency guard)", async () => {
  const store = createJobStore([
    {
      id: "running-job",
      status: "running", // already running — should not be re-dispatched
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      current_step: "ongoing work",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 1,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  await runHeartbeatAlarm(state, makeEnv(), data, async () => undefined);
  await flushWaitUntil(waitUntilPromises);

  // No waitUntil calls should have been made for the already-running job.
  assert.equal(waitUntilPromises.length, 0, "no jobs should be dispatched when all are already running");
  // Status unchanged.
  assert.equal(store.jobs.get("running-job")?.status, "running");
});

test("bridge uses current_step as prompt for paused jobs", async () => {
  const capturedMessages: string[] = [];
  const store = createJobStore([
    {
      id: "paused-job",
      status: "paused",
      created_at: Date.now() - 5000,
      updated_at: Date.now() - 5000,
      current_step: "resume from step 3: write tests",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 1,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const userMsg = body?.messages?.find((m: { role: string }) => m.role === "user");
    if (userMsg) capturedMessages.push(userMsg.content);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Done.", tool_calls: [] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await runHeartbeatAlarm(state, makeEnv(), data, async () => undefined);
    await flushWaitUntil(waitUntilPromises);

    // The first user message sent to the LLM should be the current_step.
    assert.ok(
      capturedMessages.some((m) => m.includes("resume from step 3: write tests")),
      `expected current_step to be used as prompt; got: ${JSON.stringify(capturedMessages)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge falls back to repo goals for fresh queued jobs with empty current_step", async () => {
  const capturedMessages: string[] = [];
  const store = createJobStore([
    {
      id: "fresh-job",
      status: "queued",
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      current_step: "", // empty — fresh job
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 1,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: { "kyleboas/blob": ["add comprehensive tests", "improve documentation"] },
    messages: [],
    userPreferences: {},
  };

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const userMsg = body?.messages?.find((m: { role: string }) => m.role === "user");
    if (userMsg) capturedMessages.push(userMsg.content);
    // First call is the plan() call; subsequent calls are PiAgent LLM calls.
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "add comprehensive tests", tool_calls: [] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await runHeartbeatAlarm(state, makeEnv(), data, async () => undefined);
    await flushWaitUntil(waitUntilPromises);

    // plan() should have been called (at least one fetch to the LLM).
    assert.ok(callCount >= 1, "plan() should have triggered at least one LLM call");
    assert.equal(store.jobs.get("fresh-job")?.status, "completed", "fresh job should complete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bridge dispatches multiple jobs and respects call budget", async () => {
  const store = createJobStore([
    {
      id: "job-a",
      status: "queued",
      created_at: Date.now() - 3000,
      updated_at: Date.now() - 3000,
      current_step: "task A",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 2,
    },
    {
      id: "job-b",
      status: "queued",
      created_at: Date.now() - 2000,
      updated_at: Date.now() - 2000,
      current_step: "task B",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 2,
    },
    {
      id: "job-c",
      status: "queued",
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      current_step: "task C",
      tool_history: "[]",
      partial_outputs: "[]",
      sandbox_id: null,
      token_usage: 0,
      model_call_count: 0,
      estimated_calls: 2,
    },
  ]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {} };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Done.", tool_calls: [] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    // Budget of 4 allows job-a (2) + job-b (2) = 4 but not job-c (would need 6).
    await runHeartbeatAlarm(state, makeEnv({ HEARTBEAT_MODEL_CALL_LIMIT: "4" }), data, async () => undefined);

    assert.equal(store.jobs.get("job-a")?.status, "running", "job-a should be running");
    assert.equal(store.jobs.get("job-b")?.status, "running", "job-b should be running");
    assert.equal(store.jobs.get("job-c")?.status, "queued", "job-c should remain queued (budget exhausted)");

    assert.equal(waitUntilPromises.length, 2, "exactly 2 jobs should be dispatched");

    await flushWaitUntil(waitUntilPromises);

    assert.equal(store.jobs.get("job-a")?.status, "completed");
    assert.equal(store.jobs.get("job-b")?.status, "completed");
    assert.equal(store.jobs.get("job-c")?.status, "queued");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
