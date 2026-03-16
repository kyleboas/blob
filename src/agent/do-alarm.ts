import { shouldForcePause } from "../jobs/job-model";
import { buildCronAlert, detectCronAlerts, postCronAlertWithFallback } from "../jobs/cron-jobs";
import { logEvent } from "../core/observability";
import { plan } from "../core/llm";
import type { Env } from "../core/types";
import type { BlobState } from "./do";
import { rollback } from "./deploy-rollback";
import { PiAgent } from "./pi-agent";
import { getSecretsForInjection } from "./handlers/secrets";
import { getRuntimeControls } from "../core/runtime-controls";
import { diagnoseRepo, type RepoDiagnosis } from "./repo-diagnosis";
import { maybeOpenAutonomousPullRequest } from "./autonomous-pr";

export function getEffectiveHeartbeatConfig(data: BlobState, env: Env): { intervalMs: number; modelCallLimit: number } {
  return {
    intervalMs: data.settings?.heartbeatIntervalMs ?? Number(env.HEARTBEAT_INTERVAL_MS || "600000"),
    modelCallLimit: data.settings?.heartbeatModelCallLimit ?? Number(env.HEARTBEAT_MODEL_CALL_LIMIT || "10"),
  };
}

function getAutonomousHeartbeatConfig(env: Env, heartbeatIntervalMs: number): {
  enabled: boolean;
  cooldownMs: number;
  estimatedCalls: number;
  backlogSize: number;
  maxBackgroundJobs: number;
} {
  const enabled = env.AUTONOMOUS_JOB_ENABLED !== "false";
  const cooldownMs = Number.parseInt(env.AUTONOMOUS_JOB_COOLDOWN_MS ?? String(heartbeatIntervalMs), 10);
  const estimatedCalls = Number.parseInt(env.AUTONOMOUS_JOB_ESTIMATED_CALLS ?? "3", 10);
  const backlogSize = Number.parseInt(env.AUTONOMOUS_TASK_BACKLOG_SIZE ?? "3", 10);
  const maxBackgroundJobs = Number.parseInt(env.MAX_BACKGROUND_JOBS ?? "2", 10);
  return {
    enabled,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : heartbeatIntervalMs,
    estimatedCalls: Number.isFinite(estimatedCalls) && estimatedCalls > 0 ? estimatedCalls : 3,
    backlogSize: Number.isFinite(backlogSize) && backlogSize > 0 ? backlogSize : 3,
    maxBackgroundJobs: Number.isFinite(maxBackgroundJobs) && maxBackgroundJobs > 0 ? maxBackgroundJobs : 2,
  };
}

function getJobCounts(state: DurableObjectState): { queued: number; paused: number; running: number } {
  const rows = state.storage.sql.exec("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status");
  const counts = { queued: 0, paused: 0, running: 0 };
  for (const row of rows) {
    const status = String(row.status) as keyof typeof counts;
    if (status in counts) counts[status] = Number(row.count ?? 0);
  }
  return counts;
}

type BackgroundJobCounts = { queued: number; paused: number; running: number };

function getBackgroundJobCounts(state: DurableObjectState): BackgroundJobCounts {
  const rows = state.storage.sql.exec("SELECT kind, status, COUNT(*) AS count FROM jobs GROUP BY kind, status");
  const counts: BackgroundJobCounts = { queued: 0, paused: 0, running: 0 };
  for (const row of rows) {
    if (String(row.kind ?? "interactive") !== "background") continue;
    const status = String(row.status) as keyof BackgroundJobCounts;
    if (status in counts) counts[status] = Number(row.count ?? 0);
  }
  return counts;
}

function getRepoAutonomyState(
  data: BlobState,
  repo: string,
  env: Env,
  intervalMs: number,
): NonNullable<BlobState["repoAutonomy"]>[string] {
  const config = getAutonomousHeartbeatConfig(env, intervalMs);
  data.repoAutonomy = data.repoAutonomy ?? {};
  const existing = data.repoAutonomy[repo] ?? {};
  const merged = {
    enabled: existing.enabled ?? true,
    cooldownMs: existing.cooldownMs ?? config.cooldownMs,
    nextTasks: existing.nextTasks ?? [],
    lastTaskGeneratedAt: existing.lastTaskGeneratedAt,
    lastDiagnosedAt: existing.lastDiagnosedAt,
    lastDiagnosisSummary: existing.lastDiagnosisSummary,
    lastTestCommand: existing.lastTestCommand,
    lastTestStatus: existing.lastTestStatus,
    lastPullRequestUrl: existing.lastPullRequestUrl,
    lastPullRequestAt: existing.lastPullRequestAt,
    lastPullRequestNumber: existing.lastPullRequestNumber,
    lastEnqueuedAt: existing.lastEnqueuedAt,
    lastEnqueuedJobId: existing.lastEnqueuedJobId,
    lastRunAt: existing.lastRunAt,
  };
  data.repoAutonomy[repo] = merged;
  return merged;
}

function addAutonomousTask(tasks: string[], task: string | undefined, backlogSize: number): void {
  const normalized = task?.trim();
  if (!normalized) return;
  const duplicate = tasks.some((existing) => existing.toLowerCase() === normalized.toLowerCase());
  if (duplicate) return;
  if (tasks.length < backlogSize) tasks.push(normalized);
}

function generateTaskBacklog(
  goals: string[],
  diagnosis: RepoDiagnosis,
  backlogSize: number,
): string[] {
  const tasks: string[] = [];
  if (diagnosis.verificationStatus === "failed" || diagnosis.verificationStatus === "error") {
    addAutonomousTask(
      tasks,
      `Fix the failing verification in ${diagnosis.repo}: ${diagnosis.verificationOutput ?? diagnosis.summary}`,
      backlogSize,
    );
  }

  for (const run of diagnosis.failedWorkflowRuns.slice(0, 2)) {
    addAutonomousTask(tasks, `Investigate the failing workflow "${run.name}" on ${run.head_branch}`, backlogSize);
  }

  for (const signal of diagnosis.cloudflareSignals.slice(0, 2)) {
    addAutonomousTask(tasks, `Investigate Cloudflare worker signal in ${signal.worker}: ${signal.message}`, backlogSize);
  }

  for (const issue of diagnosis.openIssues.slice(0, 2)) {
    addAutonomousTask(tasks, `Work on GitHub issue #${issue.number}: ${issue.title}`, backlogSize);
  }

  for (const match of diagnosis.todoMatches.slice(0, 2)) {
    addAutonomousTask(tasks, `Investigate and address ${match}`, backlogSize);
  }

  for (const goal of goals) {
    addAutonomousTask(tasks, `Make progress on this repo goal: ${goal}`, backlogSize);
  }

  if (tasks.length === 0) {
    addAutonomousTask(tasks, `Review ${diagnosis.repo} for the next small reliability or maintenance improvement`, backlogSize);
  }

  return tasks;
}

async function maybeEnqueueAutonomousJobs(
  state: DurableObjectState,
  env: Env,
  data: BlobState,
  now: number,
  intervalMs: number,
): Promise<number> {
  const runtimeControls = await getRuntimeControls(env);
  if (runtimeControls.paused) {
    logEvent(env, "job_lifecycle", "autonomous_job_skipped_paused", {
      reason: runtimeControls.reason || "paused via config/runtime-controls.json",
    });
    return 0;
  }

  const { enabled, estimatedCalls, backlogSize, maxBackgroundJobs } = getAutonomousHeartbeatConfig(env, intervalMs);
  if (!enabled) return 0;

  let availableSlots = maxBackgroundJobs - (getBackgroundJobCounts(state).queued + getBackgroundJobCounts(state).running);
  if (availableSlots <= 0) return 0;

  const repos = [...(data.repos ?? [])];
  if (repos.length === 0) return 0;

  const orderedRepos = repos.sort((a, b) => {
    const aRun = getRepoAutonomyState(data, a, env, intervalMs).lastRunAt;
    const bRun = getRepoAutonomyState(data, b, env, intervalMs).lastRunAt;
    if (!aRun && !bRun) return 0;
    if (!aRun) return -1;
    if (!bRun) return 1;
    return Date.parse(aRun) - Date.parse(bRun);
  });

  let enqueued = 0;

  for (const repo of orderedRepos) {
    if (availableSlots <= 0) break;

    const repoState = getRepoAutonomyState(data, repo, env, intervalMs);
    if (repoState.enabled === false) continue;

    const cooldownMs = repoState.cooldownMs ?? intervalMs;
    const lastEnqueuedAt = repoState.lastEnqueuedAt ? Date.parse(repoState.lastEnqueuedAt) : 0;
    if (lastEnqueuedAt && now - lastEnqueuedAt < cooldownMs) continue;

    const repoPending = state.storage.sql.exec(
      "SELECT id FROM jobs WHERE kind='background' AND repo=? AND status IN ('queued', 'paused', 'running') LIMIT 1",
      repo,
    ).one();
    if (repoPending) continue;

    const goals = data.goals?.[repo] ?? ["improve codebase"];
    if (!repoState.nextTasks || repoState.nextTasks.length === 0) {
      const diagnosis = await diagnoseRepo(env, repo, `autonomy-diagnose-${repo.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
      repoState.lastDiagnosedAt = diagnosis.generatedAt;
      repoState.lastDiagnosisSummary = diagnosis.summary;
      repoState.lastTestCommand = diagnosis.verificationCommand;
      repoState.lastTestStatus = diagnosis.verificationStatus;
      repoState.nextTasks = generateTaskBacklog(goals, diagnosis, backlogSize);
      repoState.lastTaskGeneratedAt = diagnosis.generatedAt;
      logEvent(env, "job_lifecycle", "autonomous_repo_diagnosed", {
        repo,
        verificationStatus: diagnosis.verificationStatus,
        verificationCommand: diagnosis.verificationCommand,
      });
    }

    const task = repoState.nextTasks.shift()?.trim();
    if (!task) continue;

    const jobId = `autonomy-${repo.replace(/[^a-zA-Z0-9_-]/g, "-")}-${now}-${enqueued + 1}`;
    const sandboxId = `autonomy-${repo.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    state.storage.sql.exec(
      "INSERT INTO jobs (id, status, kind, repo, created_at, updated_at, current_step, tool_history, partial_outputs, sandbox_id, token_usage, model_call_count, estimated_calls) VALUES (?, 'queued', 'background', ?, ?, ?, ?, '[]', '[]', ?, 0, 0, ?)",
      jobId,
      repo,
      now,
      now,
      task,
      sandboxId,
      estimatedCalls,
    );
    repoState.lastEnqueuedAt = new Date(now).toISOString();
    repoState.lastEnqueuedJobId = jobId;
    logEvent(env, "job_lifecycle", "autonomous_job_enqueued", { id: jobId, repo, task, estimatedCalls });
    enqueued += 1;
    availableSlots -= 1;
  }

  return enqueued;
}

export function initializeStorageSchema(state: DurableObjectState): void {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'interactive',
      repo TEXT,
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
  try {
    state.storage.sql.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'interactive'");
  } catch (_err) {
    void _err;
  }
  try {
    state.storage.sql.exec("ALTER TABLE jobs ADD COLUMN repo TEXT");
  } catch (_err) {
    void _err;
  }

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
    const enqueuedAutonomousJobs = await maybeEnqueueAutonomousJobs(state, env, data, now, defaultIntervalMs);
    if (enqueuedAutonomousJobs > 0) {
      await save();
    }

    // Fetch queued/paused jobs with all fields needed for dispatch in a single query.
    const pendingJobs = state.storage.sql.exec(
      "SELECT id, status, kind, repo, created_at, estimated_calls, current_step, tool_history, partial_outputs, sandbox_id FROM jobs WHERE status IN ('queued', 'paused') ORDER BY created_at ASC",
    );
    let remainingBackgroundSlots = Math.max(
      0,
      getAutonomousHeartbeatConfig(env, defaultIntervalMs).maxBackgroundJobs - getBackgroundJobCounts(state).running,
    );

    // Collect jobs to dispatch (materialise before mutating rows).
    const toDispatch: Array<{
      id: string;
      status: string;
      kind: "interactive" | "background";
      repo: string | undefined;
      currentStep: string;
      toolHistory: string;
      partialOutputs: string;
      sandboxId: string | undefined;
    }> = [];

    for (const row of pendingJobs) {
      if (callsRemaining <= 0) break;
      const id = String(row.id);
      const createdAt = Number(row.created_at);
      const estimatedCalls = Number(row.estimated_calls ?? 1);
      const kind = String(row.kind ?? "interactive") === "background" ? "background" : "interactive";
      const repo = row.repo ? String(row.repo) : undefined;

      if (estimatedCalls > callsRemaining) continue;
      if (kind === "background" && remainingBackgroundSlots <= 0) continue;

      if (shouldForcePause(createdAt, now)) {
        state.storage.sql.exec("UPDATE jobs SET status='paused', updated_at=? WHERE id=?", now, id);
        continue;
      }

      // Mark as running before dispatching — this is the concurrency guard.
      // Because the DO is single-threaded, no other heartbeat can observe the
      // same job as 'queued'/'paused' until after this synchronous loop finishes.
      state.storage.sql.exec(
        "UPDATE jobs SET status='running', updated_at=?, model_call_count=model_call_count+1 WHERE id=?",
        now,
        id,
      );
      callsRemaining -= estimatedCalls;
      if (kind === "background") remainingBackgroundSlots -= 1;

      toDispatch.push({
        id,
        status: String(row.status),
        kind,
        repo,
        currentStep: String(row.current_step ?? ""),
        toolHistory: String(row.tool_history ?? "[]"),
        partialOutputs: String(row.partial_outputs ?? "[]"),
        sandboxId: row.sandbox_id ? String(row.sandbox_id) : undefined,
      });
    }

    // Dispatch each job to PiAgent via state.waitUntil so the alarm returns
    // promptly and the agent work continues in the background.
    const secrets = getSecretsForInjection(state.storage);
    const verbosity = data.settings?.verbosity ?? "minimal";

    for (const job of toDispatch) {
      const { id, status, currentStep, sandboxId, repo: jobRepo, kind } = job;

      const promise = (async () => {
        try {
          const repo = jobRepo ?? data.repos?.[0] ?? "default";
          const repoGoals: string[] = data.goals?.[repo] ?? ["improve codebase"];
          // For a fresh queued job with no prior step, derive the task from
          // the repo's goals using the planner.  For a paused/resumed job,
          // current_step contains the description of where it left off.
          let userMessage: string;
          if (currentStep) {
            userMessage = currentStep;
          } else {
            // Fresh job — ask the planner what to do next given the goals.
            userMessage = await plan(repoGoals, env).catch(() => repoGoals[0] ?? "improve codebase");
          }

      logEvent(env, "job_lifecycle", "job_dispatched", { id, status, userMessage: userMessage.slice(0, 120) });

          const agent = new PiAgent(env, repo);
          await agent.run(userMessage, {
            sandboxId: sandboxId ?? id,
            secrets,
            verbosity,
            conversationKey: id,
          });

          // Mark as completed.
          state.storage.sql.exec(
            "UPDATE jobs SET status='completed', updated_at=? WHERE id=?",
            Date.now(),
            id,
          );
          if (kind === "background") {
            const repoState = getRepoAutonomyState(data, repo, env, defaultIntervalMs);
            const pr = await maybeOpenAutonomousPullRequest({
              env,
              repo,
              task: userMessage,
              jobId: id,
              sandboxId: sandboxId ?? id,
              diagnosisSummary: repoState.lastDiagnosisSummary,
            }).catch((error) => ({ status: "skipped" as const, reason: String(error) }));
            if (pr.status === "opened") {
              repoState.lastPullRequestUrl = pr.url;
              repoState.lastPullRequestNumber = pr.number;
              repoState.lastPullRequestAt = new Date().toISOString();
              logEvent(env, "job_lifecycle", "autonomous_pr_opened", {
                id,
                repo,
                url: pr.url,
                number: pr.number,
                branch: pr.branch,
              });
            } else {
              logEvent(env, "job_lifecycle", "autonomous_pr_skipped", {
                id,
                repo,
                reason: pr.reason,
              });
            }
            repoState.lastRunAt = new Date().toISOString();
            await save();
          }
          logEvent(env, "job_lifecycle", "job_completed", { id });
        } catch (error) {
          // Mark as failed so the job does not get re-dispatched indefinitely.
          state.storage.sql.exec(
            "UPDATE jobs SET status='failed', updated_at=? WHERE id=?",
            Date.now(),
            id,
          );
          if (kind === "background") {
            const repo = jobRepo ?? data.repos?.[0] ?? "default";
            const repoState = getRepoAutonomyState(data, repo, env, defaultIntervalMs);
            repoState.lastRunAt = new Date().toISOString();
            await save();
          }
          logEvent(env, "job_lifecycle", "job_failed", { id, error: String(error) });
        }
      })();

      // Non-blocking: let the alarm return while agent work continues.
      state.waitUntil(promise);
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
