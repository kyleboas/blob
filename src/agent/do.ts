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
  pendingDeploy?: {
    requestId: string;
    diff: string;
    requestedAt: number;
    approvedBy?: string;
    status: "pending" | "approved" | "rejected" | "expired";
  };
  lastDeployAt?: number;
  deployMonitoring?: {
    remainingHeartbeats: number;
    consecutiveFailures: number;
    rollbackTriggeredAt?: number;
  };
}

const DEFAULT_CATALOG = {
  "workers-ai/@cf/nvidia/nemotron-3-120b-a12b": { name: "NVIDIA Nemotron 3 120B", description: "Primary model for coding and tool-calling via AI Gateway.", maxTokens: 8192 },
  "@cf/nvidia/nemotron-3-120b-a12b": { name: "NVIDIA Nemotron 3 120B", description: "Primary Workers AI fallback model when AI Gateway is unavailable.", maxTokens: 8192 },
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
