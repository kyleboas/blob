import type { RetryPolicy, RuntimeGuardrailsPolicy } from "../config/policy";

export interface GuardrailCheckResult {
  allowed: boolean;
  reason?: string;
}

export function evaluateAttemptGuardrails(
  startedAtMs: number,
  nowMs: number,
  activeAttempts: number,
  guardrails: RuntimeGuardrailsPolicy,
  retry: RetryPolicy
): GuardrailCheckResult {
  if (activeAttempts > guardrails.maxConcurrentAttempts) {
    return {
      allowed: false,
      reason: `Concurrent attempts exceeded (${activeAttempts}/${guardrails.maxConcurrentAttempts})`
    };
  }

  if (nowMs - startedAtMs > guardrails.maxRemediationDurationMs) {
    return {
      allowed: false,
      reason: `Remediation exceeded max duration of ${guardrails.maxRemediationDurationMs}ms`
    };
  }

  if (retry.maxAttempts < 1) {
    return {
      allowed: false,
      reason: "Retry maxAttempts must be at least 1"
    };
  }

  return { allowed: true };
}
