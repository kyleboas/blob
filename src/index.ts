import type { Env } from "./core/types";
import { AgentDO } from "./agent/do";
import { handleSlackEvent } from "./integrations/slack";
import { dispatchCronTask } from "./jobs/cron-jobs";
import { createLogRef, logEvent } from "./core/observability";
import { getRuntimeControls } from "./core/runtime-controls";
import { withDOAuth } from "./core/do-auth";
import { embedText } from "./core/memory-system";
import { PiAgent } from "./agent/pi-agent";
import { getRepos } from "./core/storage";

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

      if (url.pathname === "/admin/selftest") {
        return runAdminSelfTest(request, env);
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

function getAdminToken(env: Env): string | undefined {
  return env.SELFTEST_ADMIN_TOKEN ?? env.DO_AUTH_SECRET;
}

function parseBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization")?.trim();
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function runAdminSelfTest(request: Request, env: Env): Promise<Response> {
  const token = getAdminToken(env);
  if (!token) {
    return json({ ok: false, error: "Admin selftest is not configured." }, 503);
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  const providedToken = parseBearerToken(request);
  if (!providedToken || !constantTimeEqual(providedToken, token)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  let body: { repo?: string; sandboxId?: string; verbosity?: "minimal" | "verbose" } = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch (_err) {
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
  }

  const repos = await getRepos(env);
  const repo = body.repo?.trim() || repos[0] || "kyleboas/blob";
  const verbosity = body.verbosity === "verbose" ? "verbose" : "minimal";
  const sandboxId = body.sandboxId?.trim() || `admin-selftest-${Date.now()}`;
  const startedAt = Date.now();

  logEvent(env, "tool_call", "admin_selftest_started", { repo, sandboxId });
  const agent = new PiAgent(env, repo);
  const message = await agent.runSelfTest({
    sandboxId,
    verbosity,
    conversationKey: `admin:selftest:${repo}`,
    onProgress: async (progress) => {
      logEvent(env, "tool_call", "admin_selftest_progress", { repo, sandboxId, progress });
    },
  });
  const passed = /self-test passed/i.test(message);
  const durationMs = Date.now() - startedAt;
  logEvent(env, "tool_call", "admin_selftest_completed", { repo, sandboxId, passed, durationMs });

  return json({
    ok: true,
    passed,
    repo,
    sandboxId,
    durationMs,
    message,
  }, passed ? 200 : 500);
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeSandbox(env: Env): Promise<boolean> {
  if (typeof env.SANDBOX.start !== "function") {
    return false;
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await env.SANDBOX.start();
      if (typeof env.SANDBOX.exec === "function") {
        const result = await env.SANDBOX.exec("true");
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.stdout || "sandbox exec failed");
        }
      }
      return true;
    } catch (err) {
      if (attempt === maxAttempts) {
        return false;
      }
      await delay(250 * attempt);
    }
  }

  return false;
}

async function runHealthChecks(env: Env): Promise<Response> {
  const timeoutMs = 5000;

  const r2Check = withTimeout(async () => {
    await env.REPO_STORE.head("config/runtime-controls.json");
    return true;
  }, timeoutMs).catch(() => false);

  const sandboxCheck = withTimeout(() => probeSandbox(env), timeoutMs).catch(() => false);

  const vectorizeCheck = withTimeout(async () => {
    if (!env.PI_VECTORS || !env.AI) {
      return false;
    }
    const vector = await embedText(env, "blob healthcheck probe");
    if (!vector?.length) {
      return false;
    }
    const result = await env.PI_VECTORS.query(vector, { topK: 1 });
    return Array.isArray(result.matches);
  }, timeoutMs).catch(() => false);

  const doCheck = withTimeout(async () => {
    const doStub = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
    const response = await doStub.fetch("http://do/heartbeat/status", withDOAuth(env, { method: "GET" }));
    return response.ok;
  }, timeoutMs).catch(() => false);

  const [r2, sandbox, vectorize, doHealth] = await Promise.all([r2Check, sandboxCheck, vectorizeCheck, doCheck]);
  const checks = { r2, sandbox, vectorize, do: doHealth };
  const passing = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.keys(checks).length;
  const status = passing === totalChecks ? "healthy" : passing === 0 ? "unhealthy" : "degraded";

  return json({ status, checks });
}
