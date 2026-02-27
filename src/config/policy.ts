export type ErrorSource = "ci" | "runtime" | "lint" | "typecheck" | "test";

export interface RemediationScopePolicy {
  allowedPathPrefixes: string[];
  deniedPathPrefixes: string[];
  allowDependencyChanges: boolean;
  maxFilesChanged: number;
  maxLinesChanged: number;
}

export interface ValidationCheckPolicy {
  name: string;
  command?: string;
  required: boolean;
}

export interface ValidationPolicy {
  checks: ValidationCheckPolicy[];
  stopOnRequiredFailure: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface RuntimeGuardrailsPolicy {
  maxRemediationDurationMs: number;
  validationTimeoutMs: number;
  maxConcurrentAttempts: number;
}

export interface SelfHealingPolicy {
  inScopeErrorSources: ErrorSource[];
  validation: ValidationPolicy;
  remediationScope: RemediationScopePolicy;
  retry: RetryPolicy;
  guardrails: RuntimeGuardrailsPolicy;
}

export const DEFAULT_SELF_HEALING_POLICY: SelfHealingPolicy = {
  inScopeErrorSources: ["ci", "runtime", "lint", "typecheck", "test"],
  validation: {
    checks: [
      { name: "lint", required: false },
      { name: "typecheck", required: true },
      { name: "test", required: true }
    ],
    stopOnRequiredFailure: true
  },
  remediationScope: {
    allowedPathPrefixes: ["src/", "tests/"],
    deniedPathPrefixes: ["node_modules/", ".git/"],
    allowDependencyChanges: false,
    maxFilesChanged: 8,
    maxLinesChanged: 300
  },
  retry: {
    maxAttempts: 2,
    backoffMs: 250
  },
  guardrails: {
    maxRemediationDurationMs: 10 * 60 * 1000,
    validationTimeoutMs: 5 * 60 * 1000,
    maxConcurrentAttempts: 2
  }
};

export function mergeValidationPolicy(
  basePolicy: ValidationPolicy,
  overrideChecks: ValidationCheckPolicy[] = []
): ValidationPolicy {
  const checksByName = new Map(basePolicy.checks.map((check) => [check.name, check]));
  for (const overrideCheck of overrideChecks) {
    checksByName.set(overrideCheck.name, {
      ...(checksByName.get(overrideCheck.name) ?? { name: overrideCheck.name }),
      ...overrideCheck
    });
  }

  return {
    checks: Array.from(checksByName.values()),
    stopOnRequiredFailure: basePolicy.stopOnRequiredFailure
  };
}
