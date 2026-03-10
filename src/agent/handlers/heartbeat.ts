import type { BlobState } from "../do";

export type HeartbeatHandlerCtx = {
  state: DurableObjectState;
  data: BlobState;
  getEffectiveHeartbeatConfig: () => { intervalMs: number; modelCallLimit: number };
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleGetHeartbeatStatus(ctx: HeartbeatHandlerCtx): Promise<Response> {
  const nextAlarm = await ctx.state.storage.getAlarm();
  const rows = ctx.state.storage.sql.exec("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status");
  const jobCounts = {
    queued: 0,
    paused: 0,
    running: 0,
  };

  for (const row of rows) {
    const status = String(row.status) as keyof typeof jobCounts;
    if (status in jobCounts) {
      jobCounts[status] = Number(row.count);
    }
  }

  return json({
    nextAlarmAt: nextAlarm ? new Date(nextAlarm).toISOString() : null,
    lastStartedAt: ctx.data.heartbeat?.lastStartedAt ?? null,
    lastCompletedAt: ctx.data.heartbeat?.lastCompletedAt ?? null,
    callsRemaining: ctx.data.heartbeat?.callsRemaining ?? null,
    consecutiveHeartbeatFailures: ctx.data.heartbeat?.consecutiveHeartbeatFailures ?? 0,
    currentIntervalMs: ctx.data.heartbeat?.currentIntervalMs ?? ctx.getEffectiveHeartbeatConfig().intervalMs,
    lastError: ctx.data.heartbeat?.lastError ?? null,
    jobs: jobCounts,
    config: ctx.getEffectiveHeartbeatConfig(),
  });
}

export async function handleCheckEvent(request: Request, ctx: HeartbeatHandlerCtx): Promise<Response> {
  const { eventId } = (await request.json()) as { eventId: string };
  const events = ctx.data.processedEvents || [];
  const now = Date.now();
  const validEvents = events.filter((e) => now - e.timestamp < 5 * 60 * 1000);
  if (validEvents.some((e) => e.id === eventId)) {
    return json({ processed: true });
  }

  validEvents.push({ id: eventId, timestamp: now });
  ctx.data.processedEvents = validEvents;
  await ctx.save();
  return json({ processed: false });
}

export async function handleGetDailyTokens(url: URL, ctx: HeartbeatHandlerCtx): Promise<Response> {
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const row = ctx.state.storage.sql.exec("SELECT total_tokens FROM daily_token_usage WHERE date=?", date).toArray();
  const total = row.length > 0 ? Number(row[0].total_tokens) : 0;
  return json({ date, totalTokens: total });
}

export async function handleIncrementDailyTokens(request: Request, ctx: HeartbeatHandlerCtx): Promise<Response> {
  const { date, tokens } = (await request.json()) as { date: string; tokens: number };
  const existing = ctx.state.storage.sql.exec("SELECT total_tokens FROM daily_token_usage WHERE date=?", date).toArray();
  if (existing.length > 0) {
    const newTotal = Number(existing[0].total_tokens) + tokens;
    ctx.state.storage.sql.exec("UPDATE daily_token_usage SET total_tokens=? WHERE date=?", newTotal, date);
    return json({ date, totalTokens: newTotal });
  }

  ctx.state.storage.sql.exec("INSERT INTO daily_token_usage (date, total_tokens) VALUES (?, ?)", date, tokens);
  return json({ date, totalTokens: tokens });
}
