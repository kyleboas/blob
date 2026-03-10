/**
 * scoring-engine.ts — Computes a composite score for an item given a config.
 *
 * Both the live agent and the backtester import this so scoring is consistent.
 * Pure math — no LLM calls, no I/O.
 */

import type { ScoringConfig } from "./types";

/**
 * Score an item against a config. The item must have numeric properties
 * matching the weight keys in the config (e.g. contentLength, uniqueness).
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
 * Extract numeric signals from raw content for scoring.
 * Returns a record of signal names → 0-100 normalized values,
 * plus boolean flags for penalty detection.
 *
 * These signals match the default weight/penalty keys in the scoring config.
 */
export function extractContentSignals(
  content: string,
  existingHashes?: Set<string>,
): Record<string, number | boolean | string> {
  const len = content.length;

  // contentLength: normalized 0-100 (500 chars = 50, 1000+ = 100)
  const contentLength = Math.min(100, (len / 1000) * 100);

  // uniqueness: 100 if not a duplicate, 0 if duplicate
  const hash = simpleHash(content);
  const isDuplicate = existingHashes?.has(hash) ?? false;
  const uniqueness = isDuplicate ? 0 : 100;

  // freshness: always 100 for new content (decays in backtesting via timestamp)
  const freshness = 100;

  // Penalty flags
  const tooShort = len < 50;
  const duplicate = isDuplicate;

  return { contentLength, uniqueness, freshness, tooShort, duplicate, _hash: hash };
}

/** Simple string hash for deduplication. */
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
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
