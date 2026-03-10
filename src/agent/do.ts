import { assertTransition, shouldForcePause, type JobStatus } from "../jobs/job-model";
import { type CronOutcomeRecord, detectCronAlerts, buildCronAlert, postCronAlertWithFallback } from "../jobs/cron-jobs";
import { logEvent } from "../core/observability";
import {
  handleCreateCronJob,
  handleDeleteCronJob,
  handleListCronJobs,
  handleListCronOutcomes,
  handleSaveCronOutcome,
} from "./handlers/cron";
import {
  handleCheckEvent,
  handleGetDailyTokens,
  handleGetHeartbeatStatus,
  handleIncrementDailyTokens,
} from "./handlers/heartbeat";
import { handleDeleteSecret, handleListSecrets, handleSaveSecret } from "./handlers/secrets";

export interface CronJob {
  id: string;
  schedule: string;
  task: string;
  enabled: boolean;
  createdAt: number;
}

export interface BlobState {
  repos: string[];
  goals: Record<string, string[]>;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  userPreferences: Record<string, string>;
  modelCatalog?: Record<string, { name: string; description: string; maxTokens: number }>;
  processedEvents?: Array<{ id: string; timestamp: number }>;
  cronJobs?: CronJob[];
  migratedFromChannel?: boolean;
  lastDailySummaryDate?: string;
  cronOutcomes?: Record<string, CronOutcomeRecord>;
  settings?: {
    verbosity?: "minimal" | "verbose";
    heartbeatIntervalMs?: number;
    heartbeatModelCallLimit?: number;
  };
  learnedMemory?: {
    lastFlushAt?: string;
    lastFlushCount?: number;
    lastRecordTimestamp?: string;
    lastRecordSummary?: string;
  };
  vectorizeMemory?: {
    lastUpsertAt?: string;
    lastUpsertOk?: boolean;
    lastUpsertError?: string;
    lastQueryAt?: string;
    lastQueryCount?: number;
  };
  heartbeat?: {
    lastStartedAt?: string;
    lastCompletedAt?: string;
    callsRemaining?: number;
  };
}

const DEFAULT_CATALOG: Record<string, { name: string; description: string; maxTokens: number }> = {
  "anthropic/claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    description: "Best-in-class tool calling and code generation via AI Gateway.",
    maxTokens: 8192,
  },
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
    name: "Llama 3.3 70B Fast",
    description: "Fast, capable model for most coding tasks. Free tier fallback.",
    maxTokens: 4096,
  },
};

export class AgentDO {
  private state: DurableObjectState;
  private env: { SLACK_BOT_TOKEN?: string; SLACK_SUMMARY_CHANNEL?: string; REPO_STORE?: R2Bucket; CRON_FAIL_THRESHOLD?: string; CRON_STALL_MULTIPLIER?: string; HEARTBEAT_MODEL_CALL_LIMIT?: string; HEARTBEAT_INTERVAL_MS?: string; AGENT_DO?: DurableObjectNamespace };
  private data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: {},
    messages: [],
    userPreferences: {},
    modelCatalog: DEFAULT_CATALOG,
  };
  private initialized = false;

  constructor(state: DurableObjectState, env: { SLACK_BOT_TOKEN?: string; SLACK_SUMMARY_CHANNEL?: string; REPO_STORE?: R2Bucket; CRON_FAIL_THRESHOLD?: string; CRON_STALL_MULTIPLIER?: string; HEARTBEAT_MODEL_CALL_LIMIT?: string; HEARTBEAT_INTERVAL_MS?: string; AGENT_DO?: DurableObjectNamespace }) {
    this.state = state;
    this.env = env;
  }

  private getEffectiveHeartbeatConfig(): { intervalMs: number; modelCallLimit: number } {
    return {
      intervalMs: this.data.settings?.heartbeatIntervalMs ?? Number(this.env.HEARTBEAT_INTERVAL_MS || "600000"),
      modelCallLimit: this.data.settings?.heartbeatModelCallLimit ?? Number(this.env.HEARTBEAT_MODEL_CALL_LIMIT || "10"),
    };
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    const stored = await this.state.storage.get<BlobState>("data");
    if (stored) {
      this.data = { ...this.data, ...stored };
    }

    this.state.storage.sql.exec(`
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

    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily_token_usage (
        date TEXT PRIMARY KEY,
        total_tokens INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        author TEXT,
        sitename TEXT,
        ext TEXT,
        message TEXT NOT NULL DEFAULT ''
      )
    `);

    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS service_secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.ensureColumn("logs", "author", "TEXT");
    this.ensureColumn("logs", "sitename", "TEXT");
    this.ensureColumn("logs", "ext", "TEXT");

    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      const { intervalMs } = this.getEffectiveHeartbeatConfig();
      await this.state.storage.setAlarm(Date.now() + intervalMs);
    }

    this.initialized = true;
  }

  async alarm(): Promise<void> {
    await this.init();
    const startedAt = new Date().toISOString();
    this.data.heartbeat = { ...(this.data.heartbeat ?? {}), lastStartedAt: startedAt };
    logEvent(this.env, "heartbeat", "alarm_start");
    const { intervalMs, modelCallLimit: maxCalls } = this.getEffectiveHeartbeatConfig();
    const now = Date.now();
    let callsRemaining = maxCalls;

    const runningJobs = this.state.storage.sql.exec(
      "SELECT id, status, created_at, estimated_calls FROM jobs WHERE status IN ('queued', 'paused') ORDER BY created_at ASC",
    );

    for (const row of runningJobs) {
      if (callsRemaining <= 0) break;
      const id = String(row.id);
      const createdAt = Number(row.created_at);
      const estimatedCalls = Number(row.estimated_calls ?? 1);

      if (estimatedCalls > callsRemaining) {
        continue;
      }

      if (shouldForcePause(createdAt, now)) {
        this.state.storage.sql.exec(
          "UPDATE jobs SET status='paused', updated_at=? WHERE id=?",
          now,
          id,
        );
        continue;
      }

      this.state.storage.sql.exec(
        "UPDATE jobs SET status='running', updated_at=?, model_call_count=model_call_count+1 WHERE id=?",
        now,
        id,
      );
      callsRemaining -= estimatedCalls;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (this.data.lastDailySummaryDate !== today) {
      await this.postDailySummary(today);
      this.data.lastDailySummaryDate = today;
      await this.save();
    }

    await this.checkCronHealthAlerts();

    this.data.heartbeat = {
      ...(this.data.heartbeat ?? {}),
      lastCompletedAt: new Date().toISOString(),
      callsRemaining,
    };
    await this.save();

    logEvent(this.env, "heartbeat", "alarm_complete", { callsRemaining, intervalMs, maxCalls });
    await this.state.storage.setAlarm(Date.now() + intervalMs);
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    const url = new URL(request.url);

    if (url.pathname === "/jobs" && request.method === "POST") {
      const now = Date.now();
      const { id, sandboxId, estimatedCalls } = (await request.json()) as { id?: string; sandboxId?: string; estimatedCalls?: number };
      const jobId = id ?? crypto.randomUUID();
      this.state.storage.sql.exec(
        "INSERT INTO jobs (id, status, created_at, updated_at, current_step, tool_history, partial_outputs, sandbox_id, token_usage, model_call_count, estimated_calls) VALUES (?, 'queued', ?, ?, '', '[]', '[]', ?, 0, 0, ?)",
        jobId,
        now,
        now,
        sandboxId ?? null,
        estimatedCalls ?? 1,
      );
      return json({ id: jobId, status: "queued" });
    }

    if (url.pathname === "/jobs/transition" && request.method === "POST") {
      const { id, to, resumeState, tokenUsage, modelCallCount } = (await request.json()) as {
        id: string;
        to: JobStatus;
        resumeState?: { currentStep?: string; toolHistory?: string; partialOutputs?: string; sandboxId?: string };
        tokenUsage?: number;
        modelCallCount?: number;
      };
      const existing = this.state.storage.sql.exec("SELECT status FROM jobs WHERE id=?", id).one();
      if (!existing) return json({ error: "Job not found" }, 404);
      const from = String(existing.status) as JobStatus;
      assertTransition(from, to);
      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE jobs SET status=?, updated_at=?, current_step=?, tool_history=?, partial_outputs=?, sandbox_id=?, token_usage=?, model_call_count=? WHERE id=?`,
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
      logEvent(this.env, "job_lifecycle", "job_transition", { id, from, to, tokenUsage: tokenUsage ?? 0, modelCallCount: modelCallCount ?? 0 });
      await this.logTokenUsage();
      return json({ id, from, to });
    }

    if (url.pathname === "/jobs" && request.method === "GET") {
      const rows = this.state.storage.sql.exec(
        "SELECT id, status, created_at, updated_at, current_step, tool_history, partial_outputs, sandbox_id, token_usage, model_call_count, estimated_calls FROM jobs ORDER BY created_at ASC",
      );
      return json({ jobs: [...rows] });
    }

    if (url.pathname === "/state/migrate" && request.method === "POST") {
      const { channelMessages } = (await request.json()) as { channelMessages?: BlobState["messages"] };
      if (!this.data.migratedFromChannel && channelMessages?.length) {
        this.data.messages = [...channelMessages, ...this.data.messages];
        this.data.migratedFromChannel = true;
        await this.save();
      }
      return json({ migrated: this.data.migratedFromChannel === true });
    }

    if (url.pathname === "/repos" && request.method === "GET") {
      return json({ repos: this.data.repos });
    }

    if (url.pathname === "/repos" && request.method === "POST") {
      const { repo } = (await request.json()) as { repo: string };
      if (!this.data.repos.includes(repo)) {
        this.data.repos.push(repo);
        await this.save();
      }
      return json({ added: repo });
    }

    if (url.pathname === "/goals" && request.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) return json({ error: "missing repo" }, 400);
      const goals = this.data.goals[repo] || ["improve codebase"];
      return json({ repo, goals });
    }

    if (url.pathname === "/goals" && request.method === "POST") {
      const { repo, goals } = (await request.json()) as { repo: string; goals: string[] };
      this.data.goals[repo] = goals;
      await this.save();
      return json({ saved: repo, goals });
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      const { role, content } = (await request.json()) as { role: string; content: string };
      this.data.messages.push({ role, content, timestamp: Date.now() });
      if (this.data.messages.length > 25) {
        await this.compactMessages();
      } else if (this.data.messages.length > 100) {
        this.data.messages = this.data.messages.slice(-100);
        await this.save();
      } else {
        await this.save();
      }
      return json({ saved: true });
    }

    if (url.pathname === "/messages" && request.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      return json({ messages: this.data.messages.slice(-limit) });
    }

    if (url.pathname === "/settings/verbosity" && request.method === "GET") {
      return json({ verbosity: this.data.settings?.verbosity ?? "minimal" });
    }

    if (url.pathname === "/settings/verbosity" && request.method === "POST") {
      const { verbosity } = (await request.json()) as { verbosity: "minimal" | "verbose" };
      if (verbosity !== "minimal" && verbosity !== "verbose") {
        return json({ error: "invalid verbosity" }, 400);
      }
      this.data.settings = { ...(this.data.settings ?? {}), verbosity };
      await this.save();
      return json({ saved: true, verbosity });
    }

    if (url.pathname === "/settings/heartbeat" && request.method === "GET") {
      const config = this.getEffectiveHeartbeatConfig();
      return json({
        intervalMs: config.intervalMs,
        modelCallLimit: config.modelCallLimit,
        source: {
          intervalMs: this.data.settings?.heartbeatIntervalMs !== undefined ? "stored" : "env",
          modelCallLimit: this.data.settings?.heartbeatModelCallLimit !== undefined ? "stored" : "env",
        },
      });
    }

    if (url.pathname === "/settings/heartbeat" && request.method === "POST") {
      const body = (await request.json()) as { intervalMs?: number; modelCallLimit?: number };
      const update: { heartbeatIntervalMs?: number; heartbeatModelCallLimit?: number } = {};
      if (typeof body.intervalMs === "number" && body.intervalMs > 0) {
        update.heartbeatIntervalMs = body.intervalMs;
      }
      if (typeof body.modelCallLimit === "number" && body.modelCallLimit > 0) {
        update.heartbeatModelCallLimit = body.modelCallLimit;
      }
      this.data.settings = { ...(this.data.settings ?? {}), ...update };
      await this.save();
      return json({ saved: true, ...this.getEffectiveHeartbeatConfig() });
    }

    if (url.pathname === "/memory/learned/status" && request.method === "GET") {
      return json({
        lastFlushAt: this.data.learnedMemory?.lastFlushAt ?? null,
        lastFlushCount: this.data.learnedMemory?.lastFlushCount ?? 0,
        lastRecordTimestamp: this.data.learnedMemory?.lastRecordTimestamp ?? null,
        lastRecordSummary: this.data.learnedMemory?.lastRecordSummary ?? null,
      });
    }

    if (url.pathname === "/memory/learned/status" && request.method === "POST") {
      const body = (await request.json()) as {
        lastFlushAt?: string;
        lastFlushCount?: number;
        lastRecordTimestamp?: string;
        lastRecordSummary?: string;
      };
      this.data.learnedMemory = {
        ...(this.data.learnedMemory ?? {}),
        ...body,
      };
      await this.save();
      return json({ saved: true, learnedMemory: this.data.learnedMemory });
    }

    if (url.pathname === "/memory/vectorize/status" && request.method === "GET") {
      return json({
        lastUpsertAt: this.data.vectorizeMemory?.lastUpsertAt ?? null,
        lastUpsertOk: this.data.vectorizeMemory?.lastUpsertOk ?? null,
        lastUpsertError: this.data.vectorizeMemory?.lastUpsertError ?? null,
        lastQueryAt: this.data.vectorizeMemory?.lastQueryAt ?? null,
        lastQueryCount: this.data.vectorizeMemory?.lastQueryCount ?? 0,
      });
    }

    if (url.pathname === "/memory/vectorize/status" && request.method === "POST") {
      const body = (await request.json()) as {
        lastUpsertAt?: string;
        lastUpsertOk?: boolean;
        lastUpsertError?: string;
        lastQueryAt?: string;
        lastQueryCount?: number;
      };
      this.data.vectorizeMemory = {
        ...(this.data.vectorizeMemory ?? {}),
        ...body,
      };
      await this.save();
      return json({ saved: true, vectorizeMemory: this.data.vectorizeMemory });
    }

    if (url.pathname === "/heartbeat/status" && request.method === "GET") {
      return handleGetHeartbeatStatus({
        state: this.state,
        data: this.data,
        getEffectiveHeartbeatConfig: this.getEffectiveHeartbeatConfig.bind(this),
        save: this.save.bind(this),
      });
    }

    if (url.pathname === "/events/check" && request.method === "POST") {
      return handleCheckEvent(request, {
        state: this.state,
        data: this.data,
        getEffectiveHeartbeatConfig: this.getEffectiveHeartbeatConfig.bind(this),
        save: this.save.bind(this),
      });
    }

    if (url.pathname === "/cron" && request.method === "GET") {
      return handleListCronJobs({ data: this.data, save: this.save.bind(this) });
    }

    if (url.pathname === "/cron" && request.method === "POST") {
      return handleCreateCronJob(request, { data: this.data, save: this.save.bind(this) });
    }


    if (url.pathname === "/cron/outcome" && request.method === "POST") {
      return handleSaveCronOutcome(request, { data: this.data, save: this.save.bind(this) });
    }

    if (url.pathname === "/cron/outcomes" && request.method === "GET") {
      return handleListCronOutcomes({ data: this.data, save: this.save.bind(this) });
    }

    if (url.pathname === "/cron/delete" && request.method === "POST") {
      return handleDeleteCronJob(request, { data: this.data, save: this.save.bind(this) });
    }

    if (url.pathname === "/daily-tokens" && request.method === "GET") {
      return handleGetDailyTokens(url, {
        state: this.state,
        data: this.data,
        getEffectiveHeartbeatConfig: this.getEffectiveHeartbeatConfig.bind(this),
        save: this.save.bind(this),
      });
    }

    if (url.pathname === "/daily-tokens" && request.method === "POST") {
      return handleIncrementDailyTokens(request, {
        state: this.state,
        data: this.data,
        getEffectiveHeartbeatConfig: this.getEffectiveHeartbeatConfig.bind(this),
        save: this.save.bind(this),
      });
    }

    if (url.pathname === "/secrets" && request.method === "GET") {
      return handleListSecrets({ state: this.state, data: this.data });
    }

    if (url.pathname === "/secrets" && request.method === "POST") {
      return handleSaveSecret(request, { state: this.state, data: this.data });
    }

    if (url.pathname === "/secrets/values" && request.method === "GET") {
      const rows = this.state.storage.sql.exec(
        "SELECT name, value FROM service_secrets ORDER BY name ASC",
      );
      const secrets: Record<string, string> = {};
      for (const row of rows) {
        secrets[String(row.name)] = String(row.value);
      }
      return json({ secrets });
    }

    if (url.pathname === "/secrets/delete" && request.method === "POST") {
      return handleDeleteSecret(request, { state: this.state, data: this.data });
    }

    return new Response("Not found", { status: 404 });
  }

  private async save(): Promise<void> {
    await this.state.storage.put("data", this.data);
  }

  private ensureColumn(table: string, column: string, typeDefinition: string): void {
    const tableInfo = this.state.storage.sql.exec(`PRAGMA table_info(${table})`).toArray();
    const hasColumn = tableInfo.some((row) => String(row.name) === column);
    if (!hasColumn) {
      this.state.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDefinition}`);
    }
  }



  private async logTokenUsage(): Promise<void> {
    const rows = this.state.storage.sql.exec("SELECT SUM(token_usage) AS total FROM jobs");
    const total = Number(rows.one()?.total ?? 0);
    const day = new Date().toISOString().slice(0, 10);
    logEvent(this.env, "cost", "token_usage_aggregate", { day, totalTokens: total });
  }

  private async checkCronHealthAlerts(): Promise<void> {
    if (!this.data.cronOutcomes || !this.env.REPO_STORE) return;
    const failThreshold = Number(this.env.CRON_FAIL_THRESHOLD || "3");
    const stallMultiplier = Number(this.env.CRON_STALL_MULTIPLIER || "2");
    const alerts = detectCronAlerts(this.data.cronOutcomes, Date.now(), { failThreshold, stallMultiplier });
    for (const alert of alerts) {
      const message = buildCronAlert({
        jobName: alert.jobName,
        status: "failure",
        durationMs: alert.durationMs ?? 0,
        outputSummary: alert.outputSummary ?? "",
        lastError: alert.lastError,
        sessionId: "heartbeat",
      }, alert);
      const alertEnv = {
        REPO_STORE: this.env.REPO_STORE,
        SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
        SLACK_SUMMARY_CHANNEL: this.env.SLACK_SUMMARY_CHANNEL,
      };
      await postCronAlertWithFallback(alertEnv, message);
    }
  }


  private async postDailySummary(date: string): Promise<void> {
    if (!this.env.SLACK_BOT_TOKEN || !this.env.SLACK_SUMMARY_CHANNEL) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: this.env.SLACK_SUMMARY_CHANNEL,
        text: `Daily heartbeat summary initialized for ${date}.`,
      }),
    });
  }

  private async compactMessages(): Promise<void> {
    const toSummarize = this.data.messages.slice(0, -20);
    const summary = `[${toSummarize.length} older messages summarized]`;
    this.data.messages = [{ role: "system", content: summary, timestamp: Date.now() }, ...this.data.messages.slice(-20)];
    await this.save();
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
