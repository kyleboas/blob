import { describe, expect, it, vi } from "vitest";
import { createRemediationPr, makeCommitMessage, makeRemediationBranchName } from "./index";
import type { NormalizedError } from "../error-ingestion";
import type { ValidationRunResult } from "../validation/index";

const error: NormalizedError = {
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

const passingValidation: ValidationRunResult = {
  passed: true,
  blockedByRequiredCheck: false,
  checks: [
    { name: "test", command: "npm test", required: true, passed: true, output: "ok" }
  ]
};

describe("pr automation", () => {
  it("builds deterministic branch names", () => {
    const branch = makeRemediationBranchName(error, new Date("2025-01-02T03:04:05.678Z"));
    expect(branch).toBe("self-heal/test-assertion-src-feature-ts/20250102T030405Z");
  });

  it("creates descriptive commit messages", () => {
    expect(makeCommitMessage({ error, attemptId: "att-01" })).toContain("attempt att-01");
  });

  it("creates branch, commits, pushes, and opens PR in sequence", async () => {
    const events: string[] = [];
    const adapter = {
      createBranch: vi.fn(async () => events.push("branch")),
      commitAll: vi.fn(async () => {
        events.push("commit");
        return "abc123";
      }),
      pushBranch: vi.fn(async () => events.push("push")),
      openPullRequest: vi.fn(async () => {
        events.push("pr");
        return { number: 17, url: "https://example/pr/17" };
      })
    };

    const result = await createRemediationPr(
      {
        error,
        validation: passingValidation,
        filesChanged: ["src/feature.ts"],
        timestamp: new Date("2025-01-02T03:04:05.678Z"),
        attemptId: "att-01"
      },
      adapter
    );

    expect(events).toEqual(["branch", "commit", "push", "pr"]);
    expect(result.pullRequestNumber).toBe(17);
    expect(adapter.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Self-heal: ASSERTION (test)",
        baseBranch: "main"
      })
    );
  });

  it("does not create PR when required checks failed", async () => {
    const adapter = {
      createBranch: vi.fn(),
      commitAll: vi.fn(),
      pushBranch: vi.fn(),
      openPullRequest: vi.fn()
    };

    await expect(
      createRemediationPr(
        {
          error,
          validation: { ...passingValidation, passed: false, blockedByRequiredCheck: true },
          filesChanged: [],
          timestamp: new Date("2025-01-02T03:04:05.678Z"),
          attemptId: "att-02"
        },
        adapter
      )
    ).rejects.toThrow("Validation failed");

    expect(adapter.createBranch).not.toHaveBeenCalled();
  });
});
