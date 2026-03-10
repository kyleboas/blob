import type { Env } from "./core/types";
import { AgentDO } from "./agent/do";
import { handleSlackEvent } from "./integrations/slack";
import { dispatchCronTask } from "./jobs/cron-jobs";
import { createLogRef, logEvent } from "./core/observability";
import { getRuntimeControls } from "./core/runtime-controls";
import { withDOAuth } from "./core/do-auth";

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
      if (url.pathname === "/health") {
        return runHealthChecks(env);
      }

      if (url.pathname === "/slack/events") {
        return handleSlackEvent(request, env, ctx);
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

async function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs);
    factory().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runHealthChecks(env: Env): Promise<Response> {
  const timeoutMs = 5000;

  const r2Check = withTimeout(async () => {
    await env.REPO_STORE.head("config/runtime-controls.json");
    return true;
  }, timeoutMs).catch(() => false);

  const sandboxCheck = withTimeout(async () => {
    if (typeof env.SANDBOX.start !== "function") {
      return false;
    }
    await env.SANDBOX.start();
    return true;
  }, timeoutMs).catch(() => false);

  const doCheck = withTimeout(async () => {
    const doStub = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
    const response = await doStub.fetch("http://do/heartbeat/status", withDOAuth(env, { method: "GET" }));
    return response.ok;
  }, timeoutMs).catch(() => false);

  const [r2, sandbox, doHealth] = await Promise.all([r2Check, sandboxCheck, doCheck]);
  const checks = { r2, sandbox, do: doHealth };
  const passing = Object.values(checks).filter(Boolean).length;
  const status = passing === 3 ? "healthy" : passing === 0 ? "unhealthy" : "degraded";

  return json({ status, checks });
}
