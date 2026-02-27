import { describe, expect, it } from "vitest";
import { DEFAULT_SELF_HEALING_POLICY } from "../config/policy";
import { classifyError } from "./classifier";
import { ingestErrors, normalizeErrorPayload, type SourceErrorPayload } from "./index";

describe("error ingestion", () => {
  const payloads: SourceErrorPayload[] = [
    {
      source: "ci",
      repository: "acme/blob",
      message: "Test failure in src/app.ts:12",
      filePath: "src/app.ts",
      line: 12,
      code: "E_TEST",
      raw: { provider: "github-actions" }
    },
    {
      source: "runtime",
      repository: "acme/blob",
      message: "Unhandled exception 500",
      filePath: "src/server.ts",
      line: 44,
      code: "E_RUNTIME",
      raw: { provider: "logs" }
    }
  ];

  it("normalizes payloads into common schema", () => {
    const normalized = normalizeErrorPayload(payloads[0]);
    expect(normalized.code).toBe("E_TEST");
    expect(normalized.filePath).toBe("src/app.ts");
    expect(normalized.fingerprint.normalizedMessage).toContain("test failure");
  });

  it("filters out sources excluded by policy", () => {
    const ingested = ingestErrors(payloads, {
      inScopeErrorSources: ["ci", "lint"]
    });

    expect(ingested).toHaveLength(1);
    expect(ingested[0].source).toBe("ci");
  });
});

describe("error classification", () => {
  it("marks in-scope source errors as eligible", () => {
    const normalized = normalizeErrorPayload({
      source: "test",
      repository: "acme/blob",
      message: "Expected true to be false",
      filePath: "tests/foo.test.ts",
      line: 10,
      code: "ASSERTION",
      raw: {}
    });

    const classification = classifyError(normalized, DEFAULT_SELF_HEALING_POLICY.remediationScope);
    expect(classification.eligible).toBe(true);
    expect(classification.route).toBe("autonomous_remediation");
  });

  it("routes blocked codes to manual triage", () => {
    const normalized = normalizeErrorPayload({
      source: "runtime",
      repository: "acme/blob",
      message: "panic: service unavailable",
      filePath: "src/server.ts",
      line: 88,
      code: "PANIC",
      raw: {}
    });

    const classification = classifyError(normalized, DEFAULT_SELF_HEALING_POLICY.remediationScope);
    expect(classification.eligible).toBe(false);
    expect(classification.reason).toContain("manual triage");
  });
});
