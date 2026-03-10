import type { RouterCtx } from "../do-router";
import { recordOutcome, loadConfig } from "../../self-improve/index";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * POST /self-improve/outcome
 * Body: { idPrefix: string, outcome: boolean }
 *
 * Records whether a scan finding was actually useful.
 * Call this when the agent uses (outcome: true) or skips (outcome: false) a finding.
 */
export async function handleRecordOutcome(request: Request, ctx: RouterCtx): Promise<Response> {
  const body = (await request.json()) as { idPrefix?: string; outcome?: boolean };
  if (!body.idPrefix || typeof body.outcome !== "boolean") {
    return json({ error: "requires idPrefix (string) and outcome (boolean)" }, 400);
  }

  const updated = await recordOutcome(ctx.env.REPO_STORE, body.idPrefix, body.outcome);
  return json({ updated, idPrefix: body.idPrefix, outcome: body.outcome });
}

/**
 * GET /self-improve/config
 *
 * Returns the current scoring config so you can see what the optimizer has tuned.
 */
export async function handleGetScoringConfig(ctx: RouterCtx): Promise<Response> {
  const config = await loadConfig(ctx.env.REPO_STORE);
  return json(config);
}
