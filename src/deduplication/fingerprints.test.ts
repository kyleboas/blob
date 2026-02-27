import { describe, expect, it, vi } from "vitest";
import { fingerprintToId, shouldCreateRemediationPr } from "./fingerprints";

describe("deduplication fingerprints", () => {
  const fingerprint = {
    repository: "acme/blob",
    source: "ci" as const,
    code: "E_TEST",
    filePath: "src/app.ts",
    line: 12,
    normalizedMessage: "test failure"
  };

  it("creates deterministic fingerprint ids", () => {
    expect(fingerprintToId(fingerprint)).toBe("acme/blob|ci|e_test|src/app.ts|12|test failure");
  });

  it("blocks creation when unresolved duplicate has open PR", async () => {
    const lookup = vi.fn(async () => true);
    const decision = await shouldCreateRemediationPr(fingerprint, lookup);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Open PR already exists");
  });

  it("allows creation when no duplicate PR exists", async () => {
    const lookup = vi.fn(async () => false);
    const decision = await shouldCreateRemediationPr(fingerprint, lookup);

    expect(decision.allowed).toBe(true);
    expect(decision.fingerprintId).toBeDefined();
  });
});
