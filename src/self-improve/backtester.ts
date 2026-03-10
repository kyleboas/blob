/**
 * backtester.ts — Replays historical outcomes against a candidate config.
 *
 * Takes a ScoringConfig + history records, re-scores every item, and returns
 * precision/recall/falsePositiveRate/compositeScore. Pure computation, no I/O.
 */

import type { ScoringConfig, HistoryRecord, BacktestResult, OptimizationSettings } from "./types";
import { DEFAULT_OPTIMIZATION_SETTINGS } from "./types";
import { scoreItem, shouldFlag } from "./scoring-engine";

/**
 * Backtest a candidate config against historical data.
 * Returns hard metrics: precision, recall, false positive rate, and a
 * weighted composite score used for tournament ranking.
 */
export function backtest(
  config: ScoringConfig,
  history: HistoryRecord[],
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS,
): BacktestResult {
  let truePositives = 0;
  let falsePositives = 0;
  let missed = 0;
  let trueNegatives = 0;

  for (const record of history) {
    const score = scoreItem(record.scores, config);
    const wouldFlag = shouldFlag(score, config);

    if (wouldFlag && record.outcome) truePositives++;
    else if (wouldFlag && !record.outcome) falsePositives++;
    else if (!wouldFlag && record.outcome) missed++;
    else trueNegatives++;
  }

  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : 0;

  const recall = truePositives + missed > 0
    ? truePositives / (truePositives + missed)
    : 0;

  const falsePositiveRate = falsePositives + trueNegatives > 0
    ? falsePositives / (falsePositives + trueNegatives)
    : 0;

  // Efficiency: ratio of true negatives correctly rejected
  const efficiency = trueNegatives + falsePositives > 0
    ? trueNegatives / (trueNegatives + falsePositives)
    : 0;

  const { precision: pw, recall: rw, efficiency: ew } = settings.compositeWeights;
  const compositeScore = pw * precision + rw * recall + ew * efficiency;

  return {
    configId: config.id,
    truePositives,
    falsePositives,
    missed,
    trueNegatives,
    precision,
    recall,
    falsePositiveRate,
    compositeScore,
    totalItems: history.length,
  };
}
