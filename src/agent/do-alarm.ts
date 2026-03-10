import { shouldForcePause } from "../jobs/job-model";
import { buildCronAlert, detectCronAlerts, postCronAlertWithFallback } from "../jobs/cron-jobs";
import { logEvent } from "../core/observability";
import type { Env } from "../core/types";
import type { BlobState } from "./do";
import { rollback } from "./deploy-rollback";

export function getEffectiveHeartbeatConfig(data: BlobState, env: Env): { intervalMs: number; modelCallLimit: number } {
  return {
    intervalMs: data.settings?.heartbeatIntervalMs ?? Number(env.HEARTBEAT_INTERVAL_MS || "600000"),
    modelCallLimit: data.settings?.heartbeatModelCallLimit ?? Number(env.HEARTBEAT_MODEL_CALL_LIMIT || "10"),
  };
}

export function initializeStorageSchema(state: DurableObjectState): void {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      current_step TEXT NOT NULL,
      tool_history TEXT NOT NULL,
      partial_outputs TEXT NOT NULL,
      sandbox_id TEXT,
      token_usage INTEGER NOT NULL DEFAULT 0,
      model_call_count INTEGER NOT NULL DEFAULT 0,
      estimated_calls INTEGER NOT NULL DEFAULT 1
    )
  `);

  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_token_usage (
      date TEXT PRIMARY KEY,
      total_tokens INTEGER NOT NULL DEFAULT 0
    )
  `);

  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      author TEXT,
      sitename TEXT,
      ext TEXT,
      message TEXT NOT NULL DEFAULT ''
    )
  `);

  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS service_secrets (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export async function runHeartbeatAlarm(state: DurableObjectState, env: Env, data: BlobState, save: () => Promise<void>): Promise<void> {
  const startedAt = new Date().toISOString();
  data.heartbeat = { ...(data.heartbeat ?? {}), lastStartedAt: startedAt };
  logEvent(env, "heartbeat", "alarm_start");
  const { intervalMs: defaultIntervalMs, modelCallLimit: maxCalls } = getEffectiveHeartbeatConfig(data, env);
  const backoffThreshold = Number.parseInt(env.HEARTBEAT_BACKOFF_THRESHOLD ?? "3", 10);
  const maxBackoffIntervalMs = 60 * 60 * 1000;
  const currentIntervalMs = data.heartbeat?.currentIntervalMs ?? defaultIntervalMs;
  const now = Date.now();
  let callsRemaining = maxCalls;

  try {
    const runningJobs = state.storage.sql.exec(
      "SELECT id, status, created_at, estimated_calls FROM jobs WHERE status IN ('queued', 'paused') ORDER BY created_at ASC",
    );

    for (const row of runningJobs) {
      if (callsRemaining <= 0) break;
      const id = String(row.id);
      const createdAt = Number(row.created_at);
      const estimatedCalls = Number(row.estimated_calls ?? 1);

      if (estimatedCalls > callsRemaining) continue;

      if (shouldForcePause(createdAt, now)) {
        state.storage.sql.exec("UPDATE jobs SET status='paused', updated_at=? WHERE id=?", now, id);
        continue;
      }

      state.storage.sql.exec(
        "UPDATE jobs SET status='running', updated_at=?, model_call_count=model_call_count+1 WHERE id=?",
        now,
        id,
      );
      callsRemaining -= estimatedCalls;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (data.lastDailySummaryDate !== today) {
      await postDailySummary(env, today);
      data.lastDailySummaryDate = today;
      await save();
    }

    await checkCronHealthAlerts(env, data.cronOutcomes);

    if (data.deployMonitoring?.remainingHeartbeats && data.deployMonitoring.remainingHeartbeats > 0) {
      data.deployMonitoring.remainingHeartbeats -= 1;
      data.deployMonitoring.consecutiveFailures = 0;
    }



    data.heartbeat = {
      ...(data.heartbeat ?? {}),
      lastCompletedAt: new Date().toISOString(),
      callsRemaining,
      consecutiveHeartbeatFailures: 0,
      currentIntervalMs: defaultIntervalMs,
      lastError: undefined,
    };
    await save();

    logEvent(env, "heartbeat", "alarm_complete", { callsRemaining, intervalMs: defaultIntervalMs, maxCalls });
    await state.storage.setAlarm(Date.now() + defaultIntervalMs);
  } catch (err) {
    const consecutive = (data.heartbeat?.consecutiveHeartbeatFailures ?? 0) + 1;
    const shouldBackoff = consecutive >= backoffThreshold;
    const nextIntervalMs = shouldBackoff
      ? Math.min(Math.max(currentIntervalMs, defaultIntervalMs) * 2, maxBackoffIntervalMs)
      : defaultIntervalMs;

    if (data.deployMonitoring?.remainingHeartbeats && data.deployMonitoring.remainingHeartbeats > 0) {
      data.deployMonitoring.remainingHeartbeats -= 1;
      data.deployMonitoring.consecutiveFailures = (data.deployMonitoring.consecutiveFailures ?? 0) + 1;
      if (data.deployMonitoring.consecutiveFailures >= Number.parseInt(env.POST_DEPLOY_HEARTBEAT_COUNT ?? "3", 10)
        && !data.deployMonitoring.rollbackTriggeredAt) {
        await rollback(env);
        data.deployMonitoring.rollbackTriggeredAt = Date.now();
      }
    }

    data.heartbeat = {
      ...(data.heartbeat ?? {}),
      consecutiveHeartbeatFailures: consecutive,
      currentIntervalMs: nextIntervalMs,
      lastError: err instanceof Error ? err.message : String(err),
    };
    await save();

    logEvent(env, "heartbeat", "alarm_failed", {
      error: String(err),
      consecutiveHeartbeatFailures: consecutive,
      backoffApplied: shouldBackoff,
      nextIntervalMs,
    });
    await state.storage.setAlarm(Date.now() + nextIntervalMs);
  }
}

async function postDailySummary(env: Env, date: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_SUMMARY_CHANNEL) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: env.SLACK_SUMMARY_CHANNEL,
      text: `Daily heartbeat summary initialized for ${date}.`,
    }),
  });
}

async function checkCronHealthAlerts(env: Env, cronOutcomes: BlobState["cronOutcomes"]): Promise<void> {
  if (!cronOutcomes || !env.REPO_STORE) return;
  const failThreshold = Number(env.CRON_FAIL_THRESHOLD || "3");
  const stallMultiplier = Number(env.CRON_STALL_MULTIPLIER || "2");
  const alerts = detectCronAlerts(cronOutcomes, Date.now(), { failThreshold, stallMultiplier });
  for (const alert of alerts) {
    const message = buildCronAlert(
      {
        jobName: alert.jobName,
        status: "failure",
        durationMs: alert.durationMs ?? 0,
        outputSummary: alert.outputSummary ?? "",
        lastError: alert.lastError,
        sessionId: "heartbeat",
      },
      alert,
    );
    await postCronAlertWithFallback(
      {
        REPO_STORE: env.REPO_STORE,
        SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
        SLACK_SUMMARY_CHANNEL: env.SLACK_SUMMARY_CHANNEL,
      },
      message,
    );
  }
}
