import type { RemediationScopePolicy } from "../config/policy";
import type { NormalizedError } from "./index";

export interface ErrorClassification {
  eligible: boolean;
  reason: string;
  route: "autonomous_remediation" | "manual_triage";
}

const BLOCKED_CODES = new Set(["SECURITY", "OUTAGE", "PANIC"]);

export function classifyError(
  error: NormalizedError,
  scopePolicy: Pick<RemediationScopePolicy, "allowedPathPrefixes" | "deniedPathPrefixes">
): ErrorClassification {
  if (BLOCKED_CODES.has(error.code)) {
    return {
      eligible: false,
      reason: `Code ${error.code} requires manual triage`,
      route: "manual_triage"
    };
  }

  if (scopePolicy.deniedPathPrefixes.some((prefix) => error.filePath.startsWith(prefix))) {
    return {
      eligible: false,
      reason: `File path ${error.filePath} is outside remediation scope`,
      route: "manual_triage"
    };
  }

  const inAllowedPath =
    error.filePath === "unknown" ||
    scopePolicy.allowedPathPrefixes.some((prefix) => error.filePath.startsWith(prefix));

  if (!inAllowedPath) {
    return {
      eligible: false,
      reason: `File path ${error.filePath} is not in allowlist`,
      route: "manual_triage"
    };
  }

  return {
    eligible: true,
    reason: "Eligible for autonomous remediation",
    route: "autonomous_remediation"
  };
}
