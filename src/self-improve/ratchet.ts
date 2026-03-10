/**
 * ratchet.ts — Quality gates that prevent the system from making things worse.
 *
 * The winner only gets promoted if it passes ALL gates:
 * 1. Minimum history size — enough labeled data to be meaningful
 * 2. Minimum precision — don't surface too much noise
 * 3. Maximum false positive rate — hard ceiling on bad flags
 * 4. Minimum improvement — must beat baseline by a meaningful margin
 *
 * If any gate fails → reject, log the reason, keep current config unchanged.
 * If all gates pass → promote the winner.
 */

import type {
  ScoringConfig,
  BacktestResult,
  GateResult,
  RatchetDecision,
  OptimizationSettings,
} from "./types";
import { DEFAULT_OPTIMIZATION_SETTINGS } from "./types";

/**
 * Run all quality gates against a candidate's backtest result.
 */
export function checkGates(
  baselineResult: BacktestResult,
  candidateResult: BacktestResult,
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS,
): GateResult[] {
  const gates: GateResult[] = [];

  // Gate 1: Minimum history size
  gates.push({
    gate: "min-history-size",
    passed: candidateResult.totalItems >= settings.gates.minHistorySize,
    reason: candidateResult.totalItems >= settings.gates.minHistorySize
      ? `History has ${candidateResult.totalItems} items (>= ${settings.gates.minHistorySize})`
      : `Only ${candidateResult.totalItems} items in history (need >= ${settings.gates.minHistorySize})`,
    value: candidateResult.totalItems,
    threshold: settings.gates.minHistorySize,
  });

  // Gate 2: Minimum precision
  gates.push({
    gate: "min-precision",
    passed: candidateResult.precision >= settings.gates.minPrecision,
    reason: candidateResult.precision >= settings.gates.minPrecision
      ? `Precision ${candidateResult.precision.toFixed(3)} >= ${settings.gates.minPrecision}`
      : `Precision ${candidateResult.precision.toFixed(3)} below minimum ${settings.gates.minPrecision}`,
    value: candidateResult.precision,
    threshold: settings.gates.minPrecision,
  });

  // Gate 3: Maximum false positive rate
  gates.push({
    gate: "max-false-positive-rate",
    passed: candidateResult.falsePositiveRate <= settings.gates.maxFalsePositiveRate,
    reason: candidateResult.falsePositiveRate <= settings.gates.maxFalsePositiveRate
      ? `FP rate ${candidateResult.falsePositiveRate.toFixed(3)} <= ${settings.gates.maxFalsePositiveRate}`
      : `FP rate ${candidateResult.falsePositiveRate.toFixed(3)} exceeds max ${settings.gates.maxFalsePositiveRate}`,
    value: candidateResult.falsePositiveRate,
    threshold: settings.gates.maxFalsePositiveRate,
  });

  // Gate 4: Minimum improvement over baseline
  const improvement = candidateResult.compositeScore - baselineResult.compositeScore;
  gates.push({
    gate: "min-improvement",
    passed: improvement >= settings.gates.minImprovement,
    reason: improvement >= settings.gates.minImprovement
      ? `Improvement ${improvement.toFixed(4)} >= ${settings.gates.minImprovement}`
      : `Improvement ${improvement.toFixed(4)} below minimum ${settings.gates.minImprovement}`,
    value: improvement,
    threshold: settings.gates.minImprovement,
  });

  return gates;
}

/**
 * Decide whether to promote a candidate config based on quality gates.
 */
export function ratchet(
  baselineConfig: ScoringConfig,
  candidateConfig: ScoringConfig,
  baselineResult: BacktestResult,
  candidateResult: BacktestResult,
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS,
): RatchetDecision {
  const gates = checkGates(baselineResult, candidateResult, settings);
  const allPassed = gates.every((g) => g.passed);

  const failedGate = gates.find((g) => !g.passed);

  return {
    promoted: allPassed,
    candidate: candidateConfig,
    baselineResult,
    candidateResult,
    gates,
    rejectionReason: allPassed ? undefined : failedGate?.reason,
  };
}
