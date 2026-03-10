import type { RouterCtx } from "../do-router";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleUpdateDeployApproval(request: Request, ctx: RouterCtx): Promise<Response> {
  const body = await request.json() as {
    action?: "request" | "decision";
    requestId?: string;
    diff?: string;
    status?: "approved" | "rejected";
    approvedBy?: string;
    requestedAt?: number;
  };

  if (!body.requestId) return json({ error: "missing requestId" }, 400);

  if (body.action === "request") {
    ctx.data.pendingDeploy = {
      requestId: body.requestId,
      diff: body.diff ?? "",
      requestedAt: body.requestedAt ?? Date.now(),
      status: "pending",
    };
    await ctx.save();
    return json({ ok: true });
  }

  if (!ctx.data.pendingDeploy || ctx.data.pendingDeploy.requestId !== body.requestId) {
    return json({ error: "unknown requestId" }, 404);
  }

  ctx.data.pendingDeploy.status = body.status ?? "rejected";
  ctx.data.pendingDeploy.approvedBy = body.approvedBy;
  await ctx.save();
  return json({ ok: true, status: ctx.data.pendingDeploy.status });
}

export async function handleGetDeployApproval(url: URL, ctx: RouterCtx): Promise<Response> {
  const requestId = url.searchParams.get("requestId");
  const pending = ctx.data.pendingDeploy;
  if (!requestId || !pending || pending.requestId !== requestId) return json({ status: "expired" });

  if (pending.status === "pending" && Date.now() - pending.requestedAt > THIRTY_MINUTES_MS) {
    pending.status = "expired";
    await ctx.save();
  }

  return json({ status: pending.status, approvedBy: pending.approvedBy, requestedAt: pending.requestedAt });
}
