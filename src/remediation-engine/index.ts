import type { RetryPolicy, SelfHealingPolicy } from "../config/policy";
import type { NormalizedError } from "../error-ingestion";
import { evaluatePatchSafety, type PatchPlan } from "./patch-safety";

export type RemediationState = "detected" | "proposing_fix" | "applying_patch" | "failed" | "applied";

export interface RemediationAttempt {
  state: RemediationState;
  attempts: number;
  patch?: PatchPlan;
  errorMessage?: string;
}

export interface FixGenerationContext {
  error: NormalizedError;
  repositoryFiles: string[];
}

export type FixGenerator = (context: FixGenerationContext) => Promise<PatchPlan>;
export type PatchApplier = (patch: PatchPlan) => Promise<boolean>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRemediation(
  error: NormalizedError,
  policy: Pick<SelfHealingPolicy, "remediationScope" | "retry">,
  generateFix: FixGenerator,
  applyPatch: PatchApplier,
  repositoryFiles: string[] = []
): Promise<RemediationAttempt> {
  const retryPolicy: RetryPolicy = policy.retry;
  const attempt: RemediationAttempt = { state: "detected", attempts: 0 };

  for (let index = 0; index < retryPolicy.maxAttempts; index += 1) {
    attempt.attempts = index + 1;
    attempt.state = "proposing_fix";

    try {
      const patch = await generateFix({ error, repositoryFiles });
      attempt.patch = patch;

      const safety = evaluatePatchSafety(patch, policy.remediationScope);
      if (!safety.safe) {
        attempt.state = "failed";
        attempt.errorMessage = safety.reason;
        return attempt;
      }

      attempt.state = "applying_patch";
      const applied = await applyPatch(patch);
      if (applied) {
        attempt.state = "applied";
        return attempt;
      }

      attempt.errorMessage = "Patch application returned false";
    } catch (errorValue) {
      attempt.errorMessage =
        errorValue instanceof Error ? errorValue.message : "Unknown remediation failure";
    }

    if (index < retryPolicy.maxAttempts - 1) {
      await sleep(retryPolicy.backoffMs * (index + 1));
    }
  }

  attempt.state = "failed";
  return attempt;
}
