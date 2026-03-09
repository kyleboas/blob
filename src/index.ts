import type { Env } from "./core/types";
import { AgentDO } from "./agent/do";
import { handleSlackEvent } from "./integrations/slack";
import { dispatchCronTask } from "./jobs/cron-jobs";
import { createLogRef, logEvent } from "./core/observability";
import { getRuntimeControls } from "./core/runtime-controls";
import { handleEvalRequest } from "./eval/routes";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    logEvent(env, "slack_ingest", "worker_request", { path: url.pathname, method: request.method });

    try {
      if (url.pathname === "/slack/events") {
        return handleSlackEvent(request, env, ctx);
      }

      // Eval endpoints — only active when EVAL_MODE=true
      if (env.EVAL_MODE === "true" && url.pathname.startsWith("/eval/")) {
        return handleEvalRequest(request, url.pathname, env);
      }

      return json({ error: "Not found", path: url.pathname }, 404);
    } catch (err) {
      const logRef = createLogRef("worker");
      logEvent(env, "slack_ingest", "worker_unhandled_exception", { path: url.pathname, error: String(err) }, logRef);
      return json({ error: `Internal server error (ref: ${logRef})` }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const cron = event.cron;
    logEvent(env, "cron_runs", "scheduled_trigger", { cron });

    try {
      const controls = await getRuntimeControls(env);
      if (controls.paused) {
        logEvent(env, "cron_runs", "scheduled_skipped_paused", {
          cron,
          reason: controls.reason || "paused via config/runtime-controls.json",
        });
        return;
      }
      const cronOutcome = await dispatchCronTask(cron, env);
      if (cronOutcome) {
        logEvent(env, "cron_runs", "scheduled_outcome", { cron, ...cronOutcome });
      }
    } catch (err) {
      const logRef = createLogRef("cron");
      logEvent(env, "cron_runs", "scheduled_failed", { cron, error: String(err) }, logRef);
    }
  },
};

export { AgentDO };
