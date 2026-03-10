import type { CronOutcomeRecord } from "../../jobs/cron-jobs";
import type { BlobState, CronJob } from "../do";

export type CronHandlerCtx = {
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function handleListCronJobs(ctx: CronHandlerCtx): Response {
  return json({ jobs: ctx.data.cronJobs || [] });
}

export async function handleCreateCronJob(request: Request, ctx: CronHandlerCtx): Promise<Response> {
  const { schedule, task } = (await request.json()) as { schedule: string; task: string };
  const job: CronJob = { id: crypto.randomUUID(), schedule, task, enabled: true, createdAt: Date.now() };
  ctx.data.cronJobs = [...(ctx.data.cronJobs || []), job];
  await ctx.save();
  return json({ created: job });
}

export async function handleDeleteCronJob(request: Request, ctx: CronHandlerCtx): Promise<Response> {
  const { id } = (await request.json()) as { id: string };
  ctx.data.cronJobs = (ctx.data.cronJobs || []).filter((j) => j.id !== id);
  await ctx.save();
  return json({ deleted: id });
}

export async function handleSaveCronOutcome(request: Request, ctx: CronHandlerCtx): Promise<Response> {
  const outcome = (await request.json()) as {
    jobName: string;
    status: "success" | "failure" | "running";
    durationMs?: number;
    outputSummary?: string;
    lastError?: string;
  };
  const existing = ctx.data.cronOutcomes?.[outcome.jobName];
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
  ctx.data.cronOutcomes = { ...(ctx.data.cronOutcomes || {}), [outcome.jobName]: next };
  await ctx.save();
  return json({ saved: true, outcome: next });
}

export function handleListCronOutcomes(ctx: CronHandlerCtx): Response {
  return json({ outcomes: ctx.data.cronOutcomes || {} });
}
