import { assertTransition, shouldForcePause, type JobStatus } from "./job-model";

interface CronJob {
  id: string;
  schedule: string;
  task: string;
  enabled: boolean;
  createdAt: number;
}

interface BlobState {
  repos: string[];
  goals: Record<string, string[]>;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  userPreferences: Record<string, string>;
  modelCatalog?: Record<string, { name: string; description: string; maxTokens: number }>;
  processedEvents?: Array<{ id: string; timestamp: number }>;
  cronJobs?: CronJob[];
  migratedFromChannel?: boolean;
  lastDailySummaryDate?: string;
}

const DEFAULT_CATALOG: Record<string, { name: string; description: string; maxTokens: number }> = {
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
    name: "Llama 3.3 70B Fast",
    description: "Fast, capable model for most coding tasks. Free tier.",
    maxTokens: 4096,
  },
  "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct": {
    name: "Llama 4 Scout",
    description: "More powerful, multimodal. Free tier.",
    maxTokens: 8192,
  },
};

export class AgentDO {
  private state: DurableObjectState;
  private env: { SLACK_BOT_TOKEN?: string; SLACK_SUMMARY_CHANNEL?: string };
  private data: BlobState = {
    repos: ["kyleboas/blob"],
    goals: {},
    messages: [],
    userPreferences: {},
    modelCatalog: DEFAULT_CATALOG,
  };
  private initialized = false;

  constructor(state: DurableObjectState, env: { SLACK_BOT_TOKEN?: string; SLACK_SUMMARY_CHANNEL?: string }) {
    this.state = state;
    this.env = env;
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

    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    }

    this.initialized = true;
  }

  async alarm(): Promise<void> {
    await this.init();
    const maxCalls = 10;
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

    await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000);
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

    if (url.pathname === "/events/check" && request.method === "POST") {
      const { eventId } = (await request.json()) as { eventId: string };
      const events = this.data.processedEvents || [];
      const now = Date.now();
      const validEvents = events.filter((e) => now - e.timestamp < 5 * 60 * 1000);
      if (validEvents.some((e) => e.id === eventId)) {
        return json({ processed: true });
      }
      validEvents.push({ id: eventId, timestamp: now });
      this.data.processedEvents = validEvents;
      await this.save();
      return json({ processed: false });
    }

    if (url.pathname === "/cron" && request.method === "GET") {
      return json({ jobs: this.data.cronJobs || [] });
    }

    if (url.pathname === "/cron" && request.method === "POST") {
      const { schedule, task } = (await request.json()) as { schedule: string; task: string };
      const job: CronJob = { id: crypto.randomUUID(), schedule, task, enabled: true, createdAt: Date.now() };
      this.data.cronJobs = [...(this.data.cronJobs || []), job];
      await this.save();
      return json({ created: job });
    }

    if (url.pathname === "/cron/delete" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      this.data.cronJobs = (this.data.cronJobs || []).filter((j) => j.id !== id);
      await this.save();
      return json({ deleted: id });
    }

    return new Response("Not found", { status: 404 });
  }

  private async save(): Promise<void> {
    await this.state.storage.put("data", this.data);
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
