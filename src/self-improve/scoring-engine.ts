/**
 * scoring-engine.ts — Computes a composite score for an item given a config.
 *
 * Both the live agent and the backtester import this so scoring is consistent.
 * Pure math — no LLM calls, no I/O.
 */

import type { ScoringConfig } from "./types";

/**
 * Score an item against a config. The item must have numeric properties
 * matching the weight keys in the config (e.g. engagementScore, qualityScore).
 * Any penalties whose keys appear in the item as truthy values are subtracted.
 */
export function scoreItem(
  item: Record<string, number | boolean | string>,
  config: ScoringConfig,
): number {
  let score = 0;

  // Weighted sum of score dimensions
  for (const [key, weight] of Object.entries(config.weights)) {
    const value = Number(item[key] ?? 0);
    score += value * weight;
  }

  // Subtract penalties for matching flags
  for (const [key, penalty] of Object.entries(config.penalties)) {
    if (item[key]) {
      score -= penalty;
    }
  }

  return Math.max(0, score);
}

/**
 * Determine whether an item should be flagged given its score and the config thresholds.
 */
export function shouldFlag(score: number, config: ScoringConfig): boolean {
  return score >= config.thresholds.highSignal;
}

/**
 * Classify an item into a signal tier: "high", "medium", "low", or "none".
 */
export function classifySignal(
  score: number,
  config: ScoringConfig,
): "high" | "medium" | "low" | "none" {
  if (score >= config.thresholds.highSignal) return "high";
  if (score >= config.thresholds.medium) return "medium";
  if (score >= config.thresholds.low) return "low";
  return "none";
}
