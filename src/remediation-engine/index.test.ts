import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SELF_HEALING_POLICY } from "../config/policy";
import type { NormalizedError } from "../error-ingestion";
import { runRemediation } from "./index";

const baseError: NormalizedError = {
  source: "test",
  repository: "acme/blob",
  message: "Expected value mismatch",
  filePath: "src/feature.ts",
  line: 42,
  column: 5,
  code: "ASSERTION",
  raw: {},
  fingerprint: {
    repository: "acme/blob",
    source: "test",
    code: "ASSERTION",
    filePath: "src/feature.ts",
    line: 42,
    normalizedMessage: "expected value mismatch"
  }
};

describe("runRemediation", () => {
  it("applies safe patch successfully", async () => {
    const result = await runRemediation(
      baseError,
      DEFAULT_SELF_HEALING_POLICY,
      async () => ({ files: [{ path: "src/feature.ts", addedLines: 3, removedLines: 1 }] }),
      async () => true
    );

    expect(result.state).toBe("applied");
    expect(result.attempts).toBe(1);
  });

  it("blocks unsafe patches before apply", async () => {
    const applyPatch = vi.fn(async () => true);

    const result = await runRemediation(
      baseError,
      DEFAULT_SELF_HEALING_POLICY,
      async () => ({ files: [{ path: "package.json", addedLines: 1, removedLines: 0 }] }),
      applyPatch
    );

    expect(result.state).toBe("failed");
    expect(result.errorMessage).toContain("Dependency changes");
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("retries and fails when patch apply fails", async () => {
    const applyPatch = vi.fn(async () => false);
    const result = await runRemediation(
      baseError,
      { ...DEFAULT_SELF_HEALING_POLICY, retry: { maxAttempts: 2, backoffMs: 1 } },
      async () => ({ files: [{ path: "src/feature.ts", addedLines: 2, removedLines: 2 }] }),
      applyPatch
    );

    expect(result.state).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(applyPatch).toHaveBeenCalledTimes(2);
  });
});
