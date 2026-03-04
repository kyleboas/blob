import type { Env } from "./types";
import { redactUnknown } from "./safety";

export type LogCategory =
  | "slack_ingest"
  | "job_lifecycle"
  | "tool_call"
  | "memory_ops"
  | "github_ops"
  | "deploy_ops"
  | "heartbeat"
  | "cron_runs"
  | "cost";

export function createLogRef(prefix = "log"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function logEvent(env: Partial<Env> | undefined, category: LogCategory, event: string, data: Record<string, unknown> = {}, logRef?: string): string {
  const reference = logRef ?? createLogRef(category);
  const payload = {
    ts: new Date().toISOString(),
    category,
    event,
    logRef: reference,
    data: redactUnknown(data, env as Pick<Env, "SECRET_PATTERNS">),
  };
  console.log(JSON.stringify(payload));
  return reference;
}
