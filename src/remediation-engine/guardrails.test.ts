import { describe, expect, it } from "vitest";
import { evaluateAttemptGuardrails } from "./guardrails";

describe("evaluateAttemptGuardrails", () => {
  const guardrails = {
    maxRemediationDurationMs: 1000,
    validationTimeoutMs: 500,
    maxConcurrentAttempts: 2
  };

  it("allows attempt under configured limits", () => {
    const result = evaluateAttemptGuardrails(0, 500, 2, guardrails, { maxAttempts: 2, backoffMs: 10 });
    expect(result.allowed).toBe(true);
  });

  it("blocks when concurrency exceeds policy", () => {
    const result = evaluateAttemptGuardrails(0, 500, 3, guardrails, { maxAttempts: 2, backoffMs: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Concurrent attempts exceeded");
  });

  it("blocks when runtime duration is exceeded", () => {
    const result = evaluateAttemptGuardrails(0, 1500, 1, guardrails, { maxAttempts: 2, backoffMs: 10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("max duration");
  });
});
