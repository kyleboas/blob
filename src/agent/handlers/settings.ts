import type { Env } from "../../core/types";
import type { BlobState } from "../do";

export type SettingsHandlerCtx = {
  env: Env;
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function handleGetVerbosity(ctx: SettingsHandlerCtx): Response {
  return json({ verbosity: ctx.data.settings?.verbosity ?? "minimal" });
}

export async function handleSetVerbosity(request: Request, ctx: SettingsHandlerCtx): Promise<Response> {
  const { verbosity } = (await request.json()) as { verbosity: "minimal" | "verbose" };
  if (verbosity !== "minimal" && verbosity !== "verbose") {
    return json({ error: "invalid verbosity" }, 400);
  }

  ctx.data.settings = { ...(ctx.data.settings ?? {}), verbosity };
  await ctx.save();
  return json({ saved: true, verbosity });
}

export function handleGetHeartbeatSettings(ctx: SettingsHandlerCtx): Response {
  const intervalMs = ctx.data.settings?.heartbeatIntervalMs ?? Number(ctx.env.HEARTBEAT_INTERVAL_MS || "600000");
  const modelCallLimit = ctx.data.settings?.heartbeatModelCallLimit ?? Number(ctx.env.HEARTBEAT_MODEL_CALL_LIMIT || "10");

  return json({
    intervalMs,
    modelCallLimit,
    source: {
      intervalMs: ctx.data.settings?.heartbeatIntervalMs !== undefined ? "stored" : "env",
      modelCallLimit: ctx.data.settings?.heartbeatModelCallLimit !== undefined ? "stored" : "env",
    },
  });
}

export async function handleSetHeartbeatSettings(request: Request, ctx: SettingsHandlerCtx): Promise<Response> {
  const body = (await request.json()) as { intervalMs?: number; modelCallLimit?: number };
  const update: { heartbeatIntervalMs?: number; heartbeatModelCallLimit?: number } = {};

  if (typeof body.intervalMs === "number" && body.intervalMs > 0) {
    update.heartbeatIntervalMs = body.intervalMs;
  }

  if (typeof body.modelCallLimit === "number" && body.modelCallLimit > 0) {
    update.heartbeatModelCallLimit = body.modelCallLimit;
  }

  ctx.data.settings = { ...(ctx.data.settings ?? {}), ...update };
  await ctx.save();

  const intervalMs = ctx.data.settings?.heartbeatIntervalMs ?? Number(ctx.env.HEARTBEAT_INTERVAL_MS || "600000");
  const modelCallLimit = ctx.data.settings?.heartbeatModelCallLimit ?? Number(ctx.env.HEARTBEAT_MODEL_CALL_LIMIT || "10");

  return json({ saved: true, intervalMs, modelCallLimit });
}
