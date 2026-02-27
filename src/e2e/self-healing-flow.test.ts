import { describe, expect, it, vi } from "vitest";
import { normalizeErrorPayload } from "../error-ingestion";
import { classifyError } from "../error-ingestion/classifier";
import { runRemediation } from "../remediation-engine";
import { runValidation } from "../validation";
import { DEFAULT_SELF_HEALING_POLICY } from "../config/policy";
import { shouldCreateRemediationPr } from "../deduplication/fingerprints";
import { createRemediationPr } from "../pr-automation";
import { LifecycleEventRecorder } from "../observability/events";

describe("self-healing e2e flow", () => {
  it("creates PR after successful remediation and validation", async () => {
    const error = normalizeErrorPayload({
      source: "test",
      repository: "acme/blob",
      message: "Expected value mismatch",
      filePath: "src/feature.ts",
      line: 42,
      code: "ASSERTION",
      raw: {}
    });

    const events = new LifecycleEventRecorder();
    events.emit({ attemptId: "e2e-1", fingerprintId: "fp-1", status: "detected" });

    const classification = classifyError(error, DEFAULT_SELF_HEALING_POLICY.remediationScope);
    expect(classification.eligible).toBe(true);

    events.emit({ attemptId: "e2e-1", fingerprintId: "fp-1", status: "remediating" });
    const remediation = await runRemediation(
      error,
      DEFAULT_SELF_HEALING_POLICY,
      async () => ({ files: [{ path: "src/feature.ts", addedLines: 2, removedLines: 1 }] }),
      async () => true
    );
    expect(remediation.state).toBe("applied");

    events.emit({ attemptId: "e2e-1", fingerprintId: "fp-1", status: "validating", metadata: { passed: true } });
    const validation = await runValidation(
      DEFAULT_SELF_HEALING_POLICY.validation,
      { lint: "npm run lint", typecheck: "npm run typecheck", test: "npm test" },
      async () => ({ exitCode: 0, output: "ok" })
    );

    const dedupe = await shouldCreateRemediationPr(error.fingerprint, async () => false);
    expect(dedupe.allowed).toBe(true);

    const pr = await createRemediationPr(
      {
        error,
        validation,
        filesChanged: remediation.patch?.files.map((file) => file.path) ?? [],
        timestamp: new Date("2025-01-02T03:04:05.678Z"),
        attemptId: "e2e-1"
      },
      {
        createBranch: vi.fn(async () => undefined),
        commitAll: vi.fn(async () => "sha-123"),
        pushBranch: vi.fn(async () => undefined),
        openPullRequest: vi.fn(async () => ({ number: 44, url: "https://example/pr/44" }))
      }
    );

    events.emit({ attemptId: "e2e-1", fingerprintId: dedupe.fingerprintId, status: "opened", metadata: { timeToPrMs: 30000 } });
    expect(pr.pullRequestNumber).toBe(44);
    expect(events.getMetrics().successfulPrs).toBe(1);
  });

  it("skips PR creation when validation fails", async () => {
    const error = normalizeErrorPayload({
      source: "lint",
      repository: "acme/blob",
      message: "no-unused-vars",
      filePath: "src/app.ts",
      line: 6,
      code: "LINT",
      raw: {}
    });

    const validation = await runValidation(
      DEFAULT_SELF_HEALING_POLICY.validation,
      { lint: "npm run lint", typecheck: "npm run typecheck", test: "npm test" },
      async (command) => ({ exitCode: command.includes("typecheck") ? 1 : 0, output: "failed" })
    );

    await expect(
      createRemediationPr(
        {
          error,
          validation,
          filesChanged: ["src/app.ts"],
          timestamp: new Date("2025-01-02T03:04:05.678Z"),
          attemptId: "e2e-2"
        },
        {
          createBranch: vi.fn(async () => undefined),
          commitAll: vi.fn(async () => "sha-123"),
          pushBranch: vi.fn(async () => undefined),
          openPullRequest: vi.fn(async () => ({ number: 44, url: "https://example/pr/44" }))
        }
      )
    ).rejects.toThrow("Validation failed");
  });
});
