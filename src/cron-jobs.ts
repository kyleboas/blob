import type { Env } from "./types";
import { R2MemoryStore, writeMemoryItem, compactScope, reconcileMemory } from "./memory-system";
import { logEvent } from "./observability";
import { redactSecrets } from "./safety";

export type CronTaskName = "content-scan" | "memory-compaction" | "memory-reconciliation";
export type CronStatus = "success" | "failure" | "running";

export interface CronOutcomeRecord {
  jobName: CronTaskName;
  status: CronStatus;
  lastRunAt: number;
  lastSuccessAt?: number;
  lastError?: string;
  consecutiveFailures: number;
  durationMs?: number;
  outputSummary?: string;
}

export interface CronTaskOutcome {
  jobName: CronTaskName;
  status: "success" | "failure";
  durationMs: number;
  outputSummary: string;
  lastError?: string;
  sessionId: string;
}

type AlertEnv = Pick<Env, "REPO_STORE" | "SLACK_BOT_TOKEN" | "SLACK_SUMMARY_CHANNEL">;

const CRON_TO_TASK: Record<string, CronTaskName> = {
  "*/15 * * * *": "content-scan",
  "0 */6 * * *": "memory-compaction",
  "30 */6 * * *": "memory-reconciliation",
};

const EXPECTED_CADENCE_MS: Record<CronTaskName, number> = {
  "content-scan": 15 * 60 * 1000,
  "memory-compaction": 6 * 60 * 60 * 1000,
  "memory-reconciliation": 6 * 60 * 60 * 1000,
};

function summarizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postToSlack(env: AlertEnv, text: string): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_SUMMARY_CHANNEL) return false;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel: env.SLACK_SUMMARY_CHANNEL, text: redactSecrets(text, env as any) }),
  });
  return response.ok;
}

export async function dispatchCronTask(cronExpression: string, env: Env): Promise<CronTaskOutcome | null> {
  const task = CRON_TO_TASK[cronExpression];
  if (!task) return null;
  return runCronTask(task, env);
}

export async function runCronTask(jobName: CronTaskName, env: Env): Promise<CronTaskOutcome> {
  const started = Date.now();
  logEvent(env, "cron_runs", "cron_start", { jobName });
  const sessionId = crypto.randomUUID();
  try {
    if (env.SANDBOX.start) {
      await env.SANDBOX.start();
    }

    let summary = "";
    if (jobName === "content-scan") {
      summary = await runContentScan(env);
    } else if (jobName === "memory-compaction") {
      summary = await runMemoryCompaction(env);
    } else {
      summary = await runMemoryReconciliation(env);
    }

    const outcome: CronTaskOutcome = {
      jobName,
      status: "success",
      durationMs: Date.now() - started,
      outputSummary: summary,
      sessionId,
    };
    await recordCronOutcome(env, outcome);
    await postToSlack(env, `🕒 ${jobName} succeeded in ${outcome.durationMs}ms. ${summary}`);
    logEvent(env, "cron_runs", "cron_success", { jobName, durationMs: outcome.durationMs });
    return outcome;
  } catch (err) {
    const outcome: CronTaskOutcome = {
      jobName,
      status: "failure",
      durationMs: Date.now() - started,
      outputSummary: "Cron task failed",
      lastError: summarizeError(err),
      sessionId,
    };
    await recordCronOutcome(env, outcome);
    await postCronAlertWithFallback(env, buildCronAlert(outcome, undefined));
    logEvent(env, "cron_runs", "cron_failure", { jobName, error: outcome.lastError });
    return outcome;
  }
}

async function runContentScan(env: Env): Promise<string> {
  const configObj = await env.REPO_STORE.get("config/scan-targets.json");
  if (!configObj) {
    return "No scan targets configured";
  }

  const config = await configObj.json() as { sources?: Array<{ name: string; type: string; url: string }> };
  const sources = config.sources ?? [];
  const store = new R2MemoryStore(env.REPO_STORE);
  let findings = 0;

  for (const source of sources) {
    const res = await fetch(source.url);
    const content = await res.text();
    const snippet = content.slice(0, 500);
    await writeMemoryItem(env, store, {
      scope: `source:${source.name}`,
      content: `Scan finding for ${source.name}: ${snippet}`,
      source: "cron",
    });
    findings += 1;
  }

  return `Scanned ${sources.length} targets, stored ${findings} findings`;
}

async function runMemoryCompaction(env: Env): Promise<string> {
  const store = new R2MemoryStore(env.REPO_STORE);
  const items = await store.listByPrefix("mem/");
  const scopes = [...new Set(items.map((x) => x.scope))];
  let replaced = 0;
  for (const scope of scopes) {
    const result = await compactScope(env, store, scope);
    replaced += result.replaced;
  }
  return `Compacted ${replaced} memory items across ${scopes.length} scopes`;
}

async function runMemoryReconciliation(env: Env): Promise<string> {
  const store = new R2MemoryStore(env.REPO_STORE);
  const result = await reconcileMemory(env, store, []);
  return `Reconciled memory: ${result.deletedOrphans} orphan vectors deleted, ${result.reindexed} items reindexed`;
}

export async function recordCronOutcome(env: Env, outcome: CronTaskOutcome): Promise<void> {
  const do_ = env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
  await do_.fetch("http://do/cron/outcome", {
    method: "POST",
    body: JSON.stringify(outcome),
  });
}

export function buildCronAlert(outcome: CronTaskOutcome, existing?: CronOutcomeRecord): string {
  const lastSuccess = existing?.lastSuccessAt ? new Date(existing.lastSuccessAt).toISOString() : "never";
  const nextAction = outcome.status === "failure" ? "check wrangler tail logs" : "review cron schedule";
  return [
    `🚨 Cron alert: ${outcome.jobName}`,
    `Status: ${outcome.status}`,
    `Last error: ${outcome.lastError ?? "n/a"}`,
    `Last success: ${lastSuccess}`,
    `Suggested action: ${nextAction}`,
  ].join("\n");
}

export async function postCronAlertWithFallback(env: AlertEnv, message: string): Promise<"slack" | "r2"> {
  try {
    const posted = await postToSlack(env, message);
    if (posted) return "slack";
  } catch {
    // fallthrough to R2 log fallback
  }

  const date = new Date().toISOString().slice(0, 10);
  const key = `alerts/${date}.jsonl`;
  const existingObj = await env.REPO_STORE.get(key);
  const existing = existingObj ? await existingObj.text() : "";
  const line = `${JSON.stringify({ ts: new Date().toISOString(), message })}\n`;
  await env.REPO_STORE.put(key, `${existing}${line}`);
  return "r2";
}

export function detectCronAlerts(
  outcomes: Record<string, CronOutcomeRecord>,
  nowMs: number,
  opts: { failThreshold?: number; stallMultiplier?: number } = {},
): CronOutcomeRecord[] {
  const failThreshold = opts.failThreshold ?? 3;
  const stallMultiplier = opts.stallMultiplier ?? 2;
  const alerts: CronOutcomeRecord[] = [];

  for (const value of Object.values(outcomes)) {
    const cadence = EXPECTED_CADENCE_MS[value.jobName];
    const stalled = nowMs - value.lastRunAt > cadence * stallMultiplier;
    if (value.consecutiveFailures >= failThreshold || stalled) {
      alerts.push(value);
    }
  }

  return alerts;
}
