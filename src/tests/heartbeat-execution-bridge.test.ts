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
  kind?: string;
  repo?: string | null;
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
    jobs.set(job.id, { kind: "interactive", repo: null, ...job });
  }

  const exec = (query: string, ...args: unknown[]): FakeRows => {
    // SELECT pending jobs (the main dispatch query)
    if (query.includes("WHERE status IN ('queued', 'paused')")) {
      const rows = [...jobs.values()].filter(
        (j) => j.status === "queued" || j.status === "paused",
      );
      return new FakeRows(rows as unknown as Record<string, unknown>[]);
    }
    if (query.includes("SELECT kind, status, COUNT(*) AS count FROM jobs GROUP BY kind, status")) {
      const counts = new Map<string, { kind: string; status: string; count: number }>();
      for (const job of jobs.values()) {
        const kind = job.kind ?? "interactive";
        const key = `${kind}:${job.status}`;
        const existing = counts.get(key) ?? { kind, status: job.status, count: 0 };
        existing.count += 1;
        counts.set(key, existing);
      }
      return new FakeRows([...counts.values()] as unknown as Record<string, unknown>[]);
    }
    if (query.includes("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")) {
      const counts = new Map<string, number>();
      for (const job of jobs.values()) {
        counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
      }
      return new FakeRows(
        [...counts.entries()].map(([status, count]) => ({ status, count })),
      );
    }
    if (query.startsWith("SELECT id FROM jobs WHERE kind='background' AND repo=?")) {
      const repo = String(args[0]);
      const match = [...jobs.values()].find(
        (job) =>
          (job.kind ?? "interactive") === "background"
          && job.repo === repo
          && (job.status === "queued" || job.status === "paused" || job.status === "running"),
      );
      return new FakeRows(match ? [{ id: match.id }] : []);
    }
    if (query.startsWith("INSERT INTO jobs")) {
      if (args.length === 8) {
        const [id, kind, repo, createdAt, updatedAt, currentStep, sandboxId, estimatedCalls] = args as [string, string, string | null, number, number, string, string | null, number];
        jobs.set(String(id), {
          id: String(id),
          status: "queued",
          kind: String(kind),
          repo: repo ?? null,
          created_at: createdAt,
          updated_at: updatedAt,
          current_step: currentStep,
          tool_history: "[]",
          partial_outputs: "[]",
          sandbox_id: sandboxId,
          token_usage: 0,
          model_call_count: 0,
          estimated_calls: estimatedCalls,
        });
        return new FakeRows([]);
      }
      const [id, repo, createdAt, updatedAt, currentStep, sandboxId, estimatedCalls] = args as [string, string | null, number, number, string, string | null, number];
      jobs.set(String(id), {
        id: String(id),
        status: "queued",
        kind: "background",
        repo: repo ?? null,
        created_at: createdAt,
        updated_at: updatedAt,
        current_step: currentStep,
        tool_history: "[]",
        partial_outputs: "[]",
        sandbox_id: sandboxId,
        token_usage: 0,
        model_call_count: 0,
        estimated_calls: estimatedCalls,
      });
      return new FakeRows([]);
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
    REPO_STORE: {
      get: async () => null,
    } as R2Bucket,
    AUTONOMOUS_JOB_ENABLED: "false",
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

test("heartbeat enqueues and runs an autonomous job when idle", async () => {
  const store = createJobStore([]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: { "kyleboas/blob": ["improve documentation"] },
    messages: [],
    userPreferences: {},
  };

  let llmCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    llmCalls += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "improve documentation", tool_calls: [] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await runHeartbeatAlarm(state, makeEnv({ AUTONOMOUS_JOB_ENABLED: "true", AUTONOMOUS_JOB_COOLDOWN_MS: "1000" }), data, async () => undefined);

    const autonomousJob = [...store.jobs.values()].find((job) => job.id.startsWith("autonomy-"));
    assert.ok(autonomousJob, "expected heartbeat to enqueue an autonomous job when idle");
    assert.equal(autonomousJob?.status, "running", "autonomous job should be dispatched in the same heartbeat");
    assert.equal(waitUntilPromises.length, 1, "autonomous job should be executed via waitUntil");

    await flushWaitUntil(waitUntilPromises);

    const completedJob = [...store.jobs.values()].find((job) => job.id.startsWith("autonomy-"));
    assert.equal(completedJob?.status, "completed", "autonomous job should complete after async execution");
    assert.ok(data.repoAutonomy?.["kyleboas/blob"]?.lastEnqueuedAt, "repo autonomy metadata should be recorded");
    assert.ok(llmCalls >= 1, "planner/agent should make at least one LLM call for autonomous work");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat does not enqueue a new autonomous job before cooldown expires", async () => {
  const nowIso = new Date().toISOString();
  const store = createJobStore([]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: { "kyleboas/blob": ["improve documentation"] },
    messages: [],
    userPreferences: {},
    repoAutonomy: {
      "kyleboas/blob": { lastEnqueuedAt: nowIso, lastEnqueuedJobId: "autonomy-prev" },
    },
  };

  await runHeartbeatAlarm(state, makeEnv({ AUTONOMOUS_JOB_ENABLED: "true", AUTONOMOUS_JOB_COOLDOWN_MS: "3600000" }), data, async () => undefined);
  await flushWaitUntil(waitUntilPromises);

  assert.equal(store.jobs.size, 0, "no autonomous job should be enqueued during cooldown");
  assert.equal(waitUntilPromises.length, 0, "no autonomous job should be dispatched during cooldown");
});

test("heartbeat can queue autonomy work for multiple repos while respecting the background cap", async () => {
  const store = createJobStore([]);
  const { state, waitUntilPromises } = createState(store);
  const data: BlobState = {
    repos: ["kyleboas/blob", "kyleboas/other"],
    goals: {
      "kyleboas/blob": ["improve blob reliability"],
      "kyleboas/other": ["improve other repo docs"],
    },
    messages: [],
    userPreferences: {},
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const userMessage = body?.messages?.find((m: { role: string }) => m.role === "user")?.content ?? "";
    if (userMessage.includes("Return a JSON array")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '["task one","task two","task three"]', tool_calls: [] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Done.", tool_calls: [] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    await runHeartbeatAlarm(state, makeEnv({ AUTONOMOUS_JOB_ENABLED: "true", MAX_BACKGROUND_JOBS: "1" }), data, async () => undefined);
    const backgroundJobs = [...store.jobs.values()].filter((job) => job.kind === "background");
    assert.equal(backgroundJobs.length, 1, "only one background job should exist when cap=1");
    assert.equal(waitUntilPromises.length, 1, "only one background job should be dispatched when cap=1");
    assert.ok(backgroundJobs[0]?.repo, "background job should target a specific repo");
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
