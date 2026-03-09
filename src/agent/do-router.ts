import { shouldForcePause } from "../jobs/job-model";
import { type CronOutcomeRecord } from "../jobs/cron-jobs";
import { logEvent } from "../core/observability";
import type { Env } from "../core/types";
import type { BlobState, CronJob } from "./do";
import { handleCreateJob, handleListJobs, handleTransitionJob } from "./handlers/jobs";

export type RouterCtx = {
  state: DurableObjectState;
  env: Env;
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function routeRequest(
  url: URL,
  method: string,
  request: Request,
  ctx: RouterCtx,
): Promise<Response> {
  const { state, env, data, save } = ctx;
  const { pathname } = url;

  if (pathname === "/jobs" && method === "POST") {
    return handleCreateJob(request, ctx);
  }

  if (pathname === "/jobs/transition" && method === "POST") {
    return handleTransitionJob(request, ctx);
  }

  if (pathname === "/jobs" && method === "GET") {
    return handleListJobs(request, ctx);
  }

  if (pathname === "/state/migrate" && method === "POST") {
    const { channelMessages } = (await request.json()) as { channelMessages?: BlobState["messages"] };
    if (!data.migratedFromChannel && channelMessages?.length) {
      data.messages = [...channelMessages, ...data.messages];
      data.migratedFromChannel = true;
      await save();
    }
    return json({ migrated: data.migratedFromChannel === true });
  }

  if (pathname === "/repos" && method === "GET") {
    return json({ repos: data.repos });
  }

  if (pathname === "/repos" && method === "POST") {
    const { repo } = (await request.json()) as { repo: string };
    if (!data.repos.includes(repo)) {
      data.repos.push(repo);
      await save();
    }
    return json({ added: repo });
  }

  if (pathname === "/goals" && method === "GET") {
    const repo = url.searchParams.get("repo");
    if (!repo) return json({ error: "missing repo" }, 400);
    const goals = data.goals[repo] || ["improve codebase"];
    return json({ repo, goals });
  }

  if (pathname === "/goals" && method === "POST") {
    const { repo, goals } = (await request.json()) as { repo: string; goals: string[] };
    data.goals[repo] = goals;
    await save();
    return json({ saved: repo, goals });
  }

  if (pathname === "/messages" && method === "POST") {
    const { role, content } = (await request.json()) as { role: string; content: string };
    data.messages.push({ role, content, timestamp: Date.now() });
    if (data.messages.length > 100) {
      data.messages = data.messages.slice(-100);
      await save();
    } else if (data.messages.length > 25) {
      const toSummarize = data.messages.slice(0, -20);
      const summary = `[${toSummarize.length} older messages summarized]`;
      data.messages = [{ role: "system", content: summary, timestamp: Date.now() }, ...data.messages.slice(-20)];
      await save();
    } else {
      await save();
    }
    return json({ saved: true });
  }

  if (pathname === "/messages" && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "10");
    return json({ messages: data.messages.slice(-limit) });
  }

  if (pathname === "/settings/verbosity" && method === "GET") {
    return json({ verbosity: data.settings?.verbosity ?? "minimal" });
  }

  if (pathname === "/settings/verbosity" && method === "POST") {
    const { verbosity } = (await request.json()) as { verbosity: "minimal" | "verbose" };
    if (verbosity !== "minimal" && verbosity !== "verbose") {
      return json({ error: "invalid verbosity" }, 400);
    }
    data.settings = { ...(data.settings ?? {}), verbosity };
    await save();
    return json({ saved: true, verbosity });
  }

  if (pathname === "/settings/heartbeat" && method === "GET") {
    const intervalMs = data.settings?.heartbeatIntervalMs ?? Number(env.HEARTBEAT_INTERVAL_MS || "600000");
    const modelCallLimit = data.settings?.heartbeatModelCallLimit ?? Number(env.HEARTBEAT_MODEL_CALL_LIMIT || "10");
    return json({
      intervalMs,
      modelCallLimit,
      source: {
        intervalMs: data.settings?.heartbeatIntervalMs !== undefined ? "stored" : "env",
        modelCallLimit: data.settings?.heartbeatModelCallLimit !== undefined ? "stored" : "env",
      },
    });
  }

  if (pathname === "/settings/heartbeat" && method === "POST") {
    const body = (await request.json()) as { intervalMs?: number; modelCallLimit?: number };
    const update: { heartbeatIntervalMs?: number; heartbeatModelCallLimit?: number } = {};
    if (typeof body.intervalMs === "number" && body.intervalMs > 0) {
      update.heartbeatIntervalMs = body.intervalMs;
    }
    if (typeof body.modelCallLimit === "number" && body.modelCallLimit > 0) {
      update.heartbeatModelCallLimit = body.modelCallLimit;
    }
    data.settings = { ...(data.settings ?? {}), ...update };
    await save();
    const intervalMs = data.settings?.heartbeatIntervalMs ?? Number(env.HEARTBEAT_INTERVAL_MS || "600000");
    const modelCallLimit = data.settings?.heartbeatModelCallLimit ?? Number(env.HEARTBEAT_MODEL_CALL_LIMIT || "10");
    return json({ saved: true, intervalMs, modelCallLimit });
  }

  if (pathname === "/memory/learned/status" && method === "GET") {
    return json({
      lastFlushAt: data.learnedMemory?.lastFlushAt ?? null,
      lastFlushCount: data.learnedMemory?.lastFlushCount ?? 0,
      lastRecordTimestamp: data.learnedMemory?.lastRecordTimestamp ?? null,
      lastRecordSummary: data.learnedMemory?.lastRecordSummary ?? null,
    });
  }

  if (pathname === "/memory/learned/status" && method === "POST") {
    const body = (await request.json()) as {
      lastFlushAt?: string;
      lastFlushCount?: number;
      lastRecordTimestamp?: string;
      lastRecordSummary?: string;
    };
    data.learnedMemory = { ...(data.learnedMemory ?? {}), ...body };
    await save();
    return json({ saved: true, learnedMemory: data.learnedMemory });
  }

  if (pathname === "/memory/vectorize/status" && method === "GET") {
    return json({
      lastUpsertAt: data.vectorizeMemory?.lastUpsertAt ?? null,
      lastUpsertOk: data.vectorizeMemory?.lastUpsertOk ?? null,
      lastUpsertError: data.vectorizeMemory?.lastUpsertError ?? null,
      lastQueryAt: data.vectorizeMemory?.lastQueryAt ?? null,
      lastQueryCount: data.vectorizeMemory?.lastQueryCount ?? 0,
    });
  }

  if (pathname === "/memory/vectorize/status" && method === "POST") {
    const body = (await request.json()) as {
      lastUpsertAt?: string;
      lastUpsertOk?: boolean;
      lastUpsertError?: string;
      lastQueryAt?: string;
      lastQueryCount?: number;
    };
    data.vectorizeMemory = { ...(data.vectorizeMemory ?? {}), ...body };
    await save();
    return json({ saved: true, vectorizeMemory: data.vectorizeMemory });
  }

  if (pathname === "/heartbeat/status" && method === "GET") {
    const nextAlarm = await state.storage.getAlarm();
    const rows = state.storage.sql.exec(
      "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status",
    );
    const jobCounts = { queued: 0, paused: 0, running: 0 };
    for (const row of rows) {
      const status = String(row.status) as keyof typeof jobCounts;
      if (status in jobCounts) jobCounts[status] = Number(row.count);
    }
    const intervalMs = data.settings?.heartbeatIntervalMs ?? Number(env.HEARTBEAT_INTERVAL_MS || "600000");
    const modelCallLimit = data.settings?.heartbeatModelCallLimit ?? Number(env.HEARTBEAT_MODEL_CALL_LIMIT || "10");
    return json({
      nextAlarmAt: nextAlarm ? new Date(nextAlarm).toISOString() : null,
      lastStartedAt: data.heartbeat?.lastStartedAt ?? null,
      lastCompletedAt: data.heartbeat?.lastCompletedAt ?? null,
      callsRemaining: data.heartbeat?.callsRemaining ?? null,
      jobs: jobCounts,
      config: { intervalMs, modelCallLimit },
    });
  }

  if (pathname === "/events/check" && method === "POST") {
    const { eventId } = (await request.json()) as { eventId: string };
    const events = data.processedEvents || [];
    const now = Date.now();
    const validEvents = events.filter((e) => now - e.timestamp < 5 * 60 * 1000);
    if (validEvents.some((e) => e.id === eventId)) {
      return json({ processed: true });
    }
    validEvents.push({ id: eventId, timestamp: now });
    data.processedEvents = validEvents;
    await save();
    return json({ processed: false });
  }

  if (pathname === "/cron" && method === "GET") {
    return json({ jobs: data.cronJobs || [] });
  }

  if (pathname === "/cron" && method === "POST") {
    const { schedule, task } = (await request.json()) as { schedule: string; task: string };
    const job: CronJob = { id: crypto.randomUUID(), schedule, task, enabled: true, createdAt: Date.now() };
    data.cronJobs = [...(data.cronJobs || []), job];
    await save();
    return json({ created: job });
  }

  if (pathname === "/cron/outcome" && method === "POST") {
    const outcome = (await request.json()) as {
      jobName: string;
      status: "success" | "failure" | "running";
      durationMs?: number;
      outputSummary?: string;
      lastError?: string;
    };
    const existing = data.cronOutcomes?.[outcome.jobName];
    const now = Date.now();
    const next: CronOutcomeRecord = {
      jobName: outcome.jobName as CronOutcomeRecord["jobName"],
      status: outcome.status,
      lastRunAt: now,
      lastSuccessAt: outcome.status === "success" ? now : existing?.lastSuccessAt,
      lastError: outcome.lastError,
      consecutiveFailures: outcome.status === "failure" ? (existing?.consecutiveFailures ?? 0) + 1 : 0,
      durationMs: outcome.durationMs,
      outputSummary: outcome.outputSummary,
    };
    data.cronOutcomes = { ...(data.cronOutcomes || {}), [outcome.jobName]: next };
    await save();
    return json({ saved: true, outcome: next });
  }

  if (pathname === "/cron/outcomes" && method === "GET") {
    return json({ outcomes: data.cronOutcomes || {} });
  }

  if (pathname === "/cron/delete" && method === "POST") {
    const { id } = (await request.json()) as { id: string };
    data.cronJobs = (data.cronJobs || []).filter((j) => j.id !== id);
    await save();
    return json({ deleted: id });
  }

  if (pathname === "/daily-tokens" && method === "GET") {
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const row = state.storage.sql.exec("SELECT total_tokens FROM daily_token_usage WHERE date=?", date).toArray();
    const total = row.length > 0 ? Number(row[0].total_tokens) : 0;
    return json({ date, totalTokens: total });
  }

  if (pathname === "/daily-tokens" && method === "POST") {
    const { date, tokens } = (await request.json()) as { date: string; tokens: number };
    const existing = state.storage.sql.exec("SELECT total_tokens FROM daily_token_usage WHERE date=?", date).toArray();
    if (existing.length > 0) {
      const newTotal = Number(existing[0].total_tokens) + tokens;
      state.storage.sql.exec("UPDATE daily_token_usage SET total_tokens=? WHERE date=?", newTotal, date);
      return json({ date, totalTokens: newTotal });
    }
    state.storage.sql.exec("INSERT INTO daily_token_usage (date, total_tokens) VALUES (?, ?)", date, tokens);
    return json({ date, totalTokens: tokens });
  }

  if (pathname === "/secrets" && method === "GET") {
    const rows = state.storage.sql.exec("SELECT name FROM service_secrets ORDER BY name ASC");
    return json({ secrets: [...rows].map((r) => String(r.name)) });
  }

  if (pathname === "/secrets" && method === "POST") {
    const { name, value } = (await request.json()) as { name: string; value: string };
    if (!name || !value) return json({ error: "name and value required" }, 400);
    const now = Date.now();
    const existing = state.storage.sql.exec("SELECT name FROM service_secrets WHERE name=?", name).toArray();
    if (existing.length > 0) {
      state.storage.sql.exec("UPDATE service_secrets SET value=?, updated_at=? WHERE name=?", value, now, name);
    } else {
      state.storage.sql.exec(
        "INSERT INTO service_secrets (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)",
        name, value, now, now,
      );
    }
    return json({ saved: name });
  }

  if (pathname === "/secrets/values" && method === "GET") {
    const rows = state.storage.sql.exec("SELECT name, value FROM service_secrets ORDER BY name ASC");
    const secrets: Record<string, string> = {};
    for (const row of rows) {
      secrets[String(row.name)] = String(row.value);
    }
    return json({ secrets });
  }

  if (pathname === "/secrets/delete" && method === "POST") {
    const { name } = (await request.json()) as { name: string };
    state.storage.sql.exec("DELETE FROM service_secrets WHERE name=?", name);
    return json({ deleted: name });
  }

  return new Response("Not found", { status: 404 });
}
