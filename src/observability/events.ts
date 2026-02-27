export type LifecycleStatus = "detected" | "remediating" | "validating" | "opened" | "failed";

export interface LifecycleEvent {
  attemptId: string;
  fingerprintId: string;
  status: LifecycleStatus;
  timestamp: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface LifecycleMetrics {
  totalAttempts: number;
  successfulPrs: number;
  totalValidationRuns: number;
  successfulValidationRuns: number;
  totalTimeToPrMs: number;
}

export type EventSink = (event: LifecycleEvent) => void;

export class LifecycleEventRecorder {
  private readonly sink: EventSink;
  private readonly events: LifecycleEvent[] = [];
  private readonly metrics: LifecycleMetrics = {
    totalAttempts: 0,
    successfulPrs: 0,
    totalValidationRuns: 0,
    successfulValidationRuns: 0,
    totalTimeToPrMs: 0
  };

  constructor(sink?: EventSink) {
    this.sink = sink ?? (() => undefined);
  }

  emit(event: Omit<LifecycleEvent, "timestamp">): LifecycleEvent {
    const emitted: LifecycleEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };

    this.events.push(emitted);
    this.sink(emitted);

    if (emitted.status === "detected") {
      this.metrics.totalAttempts += 1;
    }

    if (emitted.status === "validating") {
      this.metrics.totalValidationRuns += 1;
      if (emitted.metadata?.passed === true) {
        this.metrics.successfulValidationRuns += 1;
      }
    }

    if (emitted.status === "opened") {
      this.metrics.successfulPrs += 1;
      const durationMs = Number(emitted.metadata?.timeToPrMs ?? 0);
      if (!Number.isNaN(durationMs) && durationMs > 0) {
        this.metrics.totalTimeToPrMs += durationMs;
      }
    }

    return emitted;
  }

  listEvents(): LifecycleEvent[] {
    return [...this.events];
  }

  getMetrics(): LifecycleMetrics & { successRate: number; validationPassRate: number; meanTimeToPrMs: number } {
    const successRate = this.metrics.totalAttempts > 0 ? this.metrics.successfulPrs / this.metrics.totalAttempts : 0;
    const validationPassRate =
      this.metrics.totalValidationRuns > 0
        ? this.metrics.successfulValidationRuns / this.metrics.totalValidationRuns
        : 0;
    const meanTimeToPrMs =
      this.metrics.successfulPrs > 0 ? this.metrics.totalTimeToPrMs / this.metrics.successfulPrs : 0;

    return {
      ...this.metrics,
      successRate,
      validationPassRate,
      meanTimeToPrMs
    };
  }
}
