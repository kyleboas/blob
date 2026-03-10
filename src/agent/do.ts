import type { CronOutcomeRecord } from "../jobs/cron-jobs";
import type { Env } from "../core/types";
import { routeRequest } from "./do-router";
import { getEffectiveHeartbeatConfig, initializeStorageSchema, runHeartbeatAlarm } from "./do-alarm";

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
  settings?: { verbosity?: "minimal" | "verbose"; heartbeatIntervalMs?: number; heartbeatModelCallLimit?: number };
  learnedMemory?: { lastFlushAt?: string; lastFlushCount?: number; lastRecordTimestamp?: string; lastRecordSummary?: string };
  vectorizeMemory?: { lastUpsertAt?: string; lastUpsertOk?: boolean; lastUpsertError?: string; lastQueryAt?: string; lastQueryCount?: number };
  heartbeat?: {
    lastStartedAt?: string;
    lastCompletedAt?: string;
    callsRemaining?: number;
    consecutiveHeartbeatFailures?: number;
    currentIntervalMs?: number;
    lastError?: string;
  };
}

const DEFAULT_CATALOG = {
  "anthropic/claude-sonnet-4-6": { name: "Claude Sonnet 4.6", description: "Best-in-class tool calling and code generation via AI Gateway.", maxTokens: 8192 },
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": { name: "Llama 3.3 70B Fast", description: "Fast, capable model for most coding tasks. Free tier fallback.", maxTokens: 4096 },
} as const;

export class AgentDO {
  private initialized = false;
  private data: BlobState = { repos: ["kyleboas/blob"], goals: {}, messages: [], userPreferences: {}, modelCatalog: DEFAULT_CATALOG };

  constructor(private state: DurableObjectState, private env: Env) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    const stored = await this.state.storage.get<BlobState>("data");
    if (stored) this.data = { ...this.data, ...stored };
    initializeStorageSchema(this.state);
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      const { intervalMs } = getEffectiveHeartbeatConfig(this.data, this.env);
      await this.state.storage.setAlarm(Date.now() + intervalMs);
    }
    this.initialized = true;
  }

  async alarm(): Promise<void> {
    await this.init();
    await runHeartbeatAlarm(this.state, this.env, this.data, this.save.bind(this));
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    return routeRequest(new URL(request.url), request.method, request, {
      state: this.state,
      env: this.env,
      data: this.data,
      save: this.save.bind(this),
    });
  }

  async save(): Promise<void> {
    await this.state.storage.put("data", this.data);
  }
}
