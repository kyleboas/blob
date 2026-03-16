import { assertTransition, type JobStatus } from "../../jobs/job-model";
import { logEvent } from "../../core/observability";
import type { Env } from "../../core/types";
import type { BlobState } from "../do";

export type JobHandlerCtx = {
  state: DurableObjectState;
  env: Env;
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleCreateJob(request: Request, ctx: JobHandlerCtx): Promise<Response> {
  const now = Date.now();
  const { id, sandboxId, estimatedCalls, kind, repo, currentStep } = (await request.json()) as {
    id?: string;
    sandboxId?: string;
    estimatedCalls?: number;
    kind?: "interactive" | "background";
    repo?: string;
    currentStep?: string;
  };
  const jobId = id ?? crypto.randomUUID();
  const jobKind = kind === "background" ? "background" : "interactive";

  ctx.state.storage.sql.exec(
    "INSERT INTO jobs (id, status, kind, repo, created_at, updated_at, current_step, tool_history, partial_outputs, sandbox_id, token_usage, model_call_count, estimated_calls) VALUES (?, 'queued', ?, ?, ?, ?, ?, '[]', '[]', ?, 0, 0, ?)",
    jobId,
    jobKind,
    repo ?? null,
    now,
    now,
    currentStep ?? "",
    sandboxId ?? null,
    estimatedCalls ?? 1,
  );

  return json({ id: jobId, status: "queued", kind: jobKind, repo: repo ?? null });
}

export async function handleListJobs(_request: Request, ctx: JobHandlerCtx): Promise<Response> {
  const rows = ctx.state.storage.sql.exec(
    "SELECT id, status, kind, repo, created_at, updated_at, current_step, tool_history, partial_outputs, sandbox_id, token_usage, model_call_count, estimated_calls FROM jobs ORDER BY created_at ASC",
  );
  return json({ jobs: [...rows] });
}

export async function handleTransitionJob(request: Request, ctx: JobHandlerCtx): Promise<Response> {
  const { id, to, resumeState, tokenUsage, modelCallCount } = (await request.json()) as {
    id: string;
    to: JobStatus;
    resumeState?: { currentStep?: string; toolHistory?: string; partialOutputs?: string; sandboxId?: string };
    tokenUsage?: number;
    modelCallCount?: number;
  };

  const existing = ctx.state.storage.sql.exec("SELECT status FROM jobs WHERE id=?", id).one();
  if (!existing) {
    return json({ error: "Job not found" }, 404);
  }

  const from = String(existing.status) as JobStatus;
  assertTransition(from, to);

  const now = Date.now();
  ctx.state.storage.sql.exec(
    "UPDATE jobs SET status=?, updated_at=?, current_step=?, tool_history=?, partial_outputs=?, sandbox_id=?, token_usage=?, model_call_count=? WHERE id=?",
    to,
    now,
    resumeState?.currentStep ?? "",
    resumeState?.toolHistory ?? "[]",
    resumeState?.partialOutputs ?? "[]",
    resumeState?.sandboxId ?? null,
    tokenUsage ?? 0,
    modelCallCount ?? 0,
    id,
  );

  logEvent(ctx.env, "job_lifecycle", "job_transition", { id, from, to, tokenUsage: tokenUsage ?? 0, modelCallCount: modelCallCount ?? 0 });
  const rows = ctx.state.storage.sql.exec("SELECT SUM(token_usage) AS total FROM jobs");
  const total = Number(rows.one()?.total ?? 0);
  const day = new Date().toISOString().slice(0, 10);
  logEvent(ctx.env, "cost", "token_usage_aggregate", { day, totalTokens: total });

  return json({ id, from, to });
}
