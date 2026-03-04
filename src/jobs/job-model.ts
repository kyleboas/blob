export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed";

export interface ResumeState {
  currentStep: string;
  toolHistory: string;
  partialOutputs: string;
  sandboxId?: string;
}

export interface AgentJob {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  resumeState: ResumeState;
  tokenUsage: number;
  modelCallCount: number;
}

const ALLOWED: Record<JobStatus, JobStatus[]> = {
  queued: ["running", "failed"],
  running: ["paused", "completed", "failed"],
  paused: ["running", "failed"],
  completed: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

export function shouldForcePause(
  createdAt: number,
  now: number,
  maxDurationMs = 30 * 60 * 1000,
): boolean {
  return now - createdAt > maxDurationMs;
}
