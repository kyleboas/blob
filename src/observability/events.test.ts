import { describe, expect, it, vi } from "vitest";
import { LifecycleEventRecorder } from "./events";

describe("lifecycle event recorder", () => {
  it("emits lifecycle events and computes aggregate metrics", () => {
    const sink = vi.fn();
    const recorder = new LifecycleEventRecorder(sink);

    recorder.emit({ attemptId: "a1", fingerprintId: "fp1", status: "detected" });
    recorder.emit({ attemptId: "a1", fingerprintId: "fp1", status: "remediating" });
    recorder.emit({ attemptId: "a1", fingerprintId: "fp1", status: "validating", metadata: { passed: true } });
    recorder.emit({ attemptId: "a1", fingerprintId: "fp1", status: "opened", metadata: { timeToPrMs: 60000 } });

    expect(recorder.listEvents()).toHaveLength(4);
    expect(sink).toHaveBeenCalledTimes(4);

    const metrics = recorder.getMetrics();
    expect(metrics.totalAttempts).toBe(1);
    expect(metrics.successfulPrs).toBe(1);
    expect(metrics.validationPassRate).toBe(1);
    expect(metrics.meanTimeToPrMs).toBe(60000);
  });

  it("tracks failed validation pass rates", () => {
    const recorder = new LifecycleEventRecorder();

    recorder.emit({ attemptId: "a2", fingerprintId: "fp2", status: "detected" });
    recorder.emit({ attemptId: "a2", fingerprintId: "fp2", status: "validating", metadata: { passed: false } });
    recorder.emit({ attemptId: "a2", fingerprintId: "fp2", status: "failed" });

    const metrics = recorder.getMetrics();
    expect(metrics.successRate).toBe(0);
    expect(metrics.validationPassRate).toBe(0);
  });
});
