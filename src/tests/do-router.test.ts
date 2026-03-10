import test from "node:test";
import assert from "node:assert/strict";
import { routeRequest, type RouterCtx } from "../agent/do-router";
import type { BlobState } from "../agent/do";
import type { Env } from "../core/types";

type Row = Record<string, unknown>;

class FakeRows {
  constructor(private readonly rows: Row[]) {}

  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]();
  }

  toArray(): Row[] {
    return [...this.rows];
  }

  one(): Row | null {
    return this.rows[0] ?? null;
  }
}

function createSqlStore() {
  const jobs = new Map<string, Row>();
  const secrets = new Map<string, string>();
  const dailyTokens = new Map<string, number>();

  const exec = (query: string, ...args: unknown[]) => {
    if (query.startsWith("INSERT INTO jobs")) {
      const [id, _status, createdAt, updatedAt, _currentStep, _toolHistory, _partialOutputs, sandboxId, _tokenUsage, _modelCallCount, estimatedCalls] = args;
      jobs.set(String(id), {
        id: String(id),
        status: "queued",
        created_at: Number(createdAt),
        updated_at: Number(updatedAt),
        current_step: "",
        tool_history: "[]",
        partial_outputs: "[]",
        sandbox_id: sandboxId ?? null,
        token_usage: 0,
        model_call_count: 0,
        estimated_calls: Number(estimatedCalls ?? 1),
      });
      return new FakeRows([]);
    }

    if (query.startsWith("SELECT id, status") && query.includes("FROM jobs ORDER BY")) {
      return new FakeRows([...jobs.values()]);
    }

    if (query.startsWith("SELECT status FROM jobs WHERE id=?")) {
      const job = jobs.get(String(args[0]));
      return new FakeRows(job ? [{ status: job.status }] : []);
    }

    if (query.startsWith("UPDATE jobs SET status=?")) {
      const [to, updatedAt, currentStep, toolHistory, partialOutputs, sandboxId, tokenUsage, modelCallCount, id] = args;
      const existing = jobs.get(String(id));
      if (existing) {
        jobs.set(String(id), {
          ...existing,
          status: String(to),
          updated_at: Number(updatedAt),
          current_step: String(currentStep),
          tool_history: String(toolHistory),
          partial_outputs: String(partialOutputs),
          sandbox_id: sandboxId ?? null,
          token_usage: Number(tokenUsage),
          model_call_count: Number(modelCallCount),
        });
      }
      return new FakeRows([]);
    }

    if (query.startsWith("SELECT SUM(token_usage) AS total FROM jobs")) {
      const total = [...jobs.values()].reduce((sum, job) => sum + Number(job.token_usage ?? 0), 0);
      return new FakeRows([{ total }]);
    }

    if (query.startsWith("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")) {
      const counts = new Map<string, number>();
      for (const job of jobs.values()) {
        const status = String(job.status);
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
      return new FakeRows([...counts.entries()].map(([status, count]) => ({ status, count })));
    }

    if (query.startsWith("SELECT total_tokens FROM daily_token_usage WHERE date=?")) {
      const value = dailyTokens.get(String(args[0]));
      return new FakeRows(value === undefined ? [] : [{ total_tokens: value }]);
    }

    if (query.startsWith("INSERT INTO daily_token_usage")) {
      dailyTokens.set(String(args[0]), Number(args[1]));
      return new FakeRows([]);
    }

    if (query.startsWith("UPDATE daily_token_usage SET total_tokens=? WHERE date=?")) {
      dailyTokens.set(String(args[1]), Number(args[0]));
      return new FakeRows([]);
    }

    if (query.startsWith("SELECT name FROM service_secrets WHERE name=?")) {
      const name = String(args[0]);
      return new FakeRows(secrets.has(name) ? [{ name }] : []);
    }

    if (query.startsWith("SELECT name FROM service_secrets ORDER BY name ASC")) {
      return new FakeRows([...secrets.keys()].sort().map((name) => ({ name })));
    }

    if (query.startsWith("SELECT name, value FROM service_secrets ORDER BY name ASC")) {
      return new FakeRows([...secrets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value })));
    }

    if (query.startsWith("INSERT INTO service_secrets")) {
      secrets.set(String(args[0]), String(args[1]));
      return new FakeRows([]);
    }

    if (query.startsWith("UPDATE service_secrets SET value=?")) {
      secrets.set(String(args[2]), String(args[0]));
      return new FakeRows([]);
    }

    if (query.startsWith("DELETE FROM service_secrets WHERE name=?")) {
      secrets.delete(String(args[0]));
      return new FakeRows([]);
    }

    throw new Error(`Unhandled query in test store: ${query}`);
  };

  return { exec };
}

function createCtx(): RouterCtx {
  const data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: {},
    messages: [],
    userPreferences: {},
    processedEvents: [],
  };

  return {
    state: {
      storage: {
        sql: createSqlStore(),
        getAlarm: async () => null,
      },
    } as unknown as DurableObjectState,
    env: {} as Env,
    data,
    save: async () => undefined,
  };
}

async function bodyJson(response: Response): Promise<any> {
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : null;
}

test("do router maps endpoints to handlers and unknown routes 404", async () => {
  const ctx = createCtx();

  const createJob = await routeRequest(
    new URL("https://example.com/jobs"),
    "POST",
    new Request("https://example.com/jobs", { method: "POST", body: JSON.stringify({ id: "job-1" }) }),
    ctx,
  );
  assert.equal(createJob.status, 200);

  const transition = await routeRequest(
    new URL("https://example.com/jobs/transition"),
    "POST",
    new Request("https://example.com/jobs/transition", { method: "POST", body: JSON.stringify({ id: "job-1", to: "running" }) }),
    ctx,
  );
  assert.equal(transition.status, 200);

  const listJobs = await routeRequest(new URL("https://example.com/jobs"), "GET", new Request("https://example.com/jobs"), ctx);
  assert.equal((await bodyJson(listJobs)).jobs.length, 1);

  const checks: Array<{ method: string; path: string; body?: Record<string, unknown>; expectStatus?: number }> = [
    { method: "POST", path: "/state/migrate", body: { channelMessages: [{ role: "user", content: "old", timestamp: 1 }] } },
    { method: "GET", path: "/repos" },
    { method: "POST", path: "/repos", body: { repo: "acme/new" } },
    { method: "GET", path: "/goals?repo=acme/new" },
    { method: "POST", path: "/goals", body: { repo: "acme/new", goals: ["ship"] } },
    { method: "POST", path: "/messages", body: { role: "user", content: "hi" } },
    { method: "GET", path: "/messages" },
    { method: "GET", path: "/settings/verbosity" },
    { method: "POST", path: "/settings/verbosity", body: { verbosity: "verbose" } },
    { method: "GET", path: "/settings/heartbeat" },
    { method: "POST", path: "/settings/heartbeat", body: { intervalMs: 60000, modelCallLimit: 3 } },
    { method: "GET", path: "/memory/learned/status" },
    { method: "POST", path: "/memory/learned/status", body: { lastFlushCount: 2 } },
    { method: "GET", path: "/memory/vectorize/status" },
    { method: "POST", path: "/memory/vectorize/status", body: { lastUpsertOk: true } },
    { method: "GET", path: "/heartbeat/status" },
    { method: "POST", path: "/events/check", body: { eventId: "evt-1" } },
    { method: "GET", path: "/cron" },
    { method: "POST", path: "/cron", body: { schedule: "* * * * *", task: "ping" } },
    { method: "POST", path: "/cron/outcome", body: { jobName: "daily-summary", status: "success" } },
    { method: "GET", path: "/cron/outcomes" },
    { method: "POST", path: "/cron/delete", body: { id: "does-not-exist" } },
    { method: "POST", path: "/deploy/approval", body: { action: "request", requestId: "req-1", diff: "x" } },
    { method: "GET", path: "/deploy/approval?requestId=req-1" },
    { method: "POST", path: "/daily-tokens", body: { date: "2025-01-01", tokens: 10 } },
    { method: "GET", path: "/daily-tokens?date=2025-01-01" },
    { method: "GET", path: "/secrets" },
    { method: "POST", path: "/secrets", body: { name: "API_KEY", value: "secret" } },
    { method: "GET", path: "/internal/secrets/injection" },
    { method: "POST", path: "/secrets/delete", body: { name: "API_KEY" } },
    { method: "GET", path: "/goals", expectStatus: 400 },
  ];

  for (const check of checks) {
    const url = `https://example.com${check.path}`;
    const response = await routeRequest(
      new URL(url),
      check.method,
      new Request(url, {
        method: check.method,
        body: check.body ? JSON.stringify(check.body) : undefined,
      }),
      ctx,
    );
    assert.equal(response.status, check.expectStatus ?? 200, `route ${check.method} ${check.path}`);
  }

  const notFound = await routeRequest(
    new URL("https://example.com/not-a-route"),
    "GET",
    new Request("https://example.com/not-a-route"),
    ctx,
  );
  assert.equal(notFound.status, 404);
});
