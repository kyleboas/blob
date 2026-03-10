/**
 * tournament.ts — Backtests every candidate config against history and ranks them.
 *
 * Returns all entries sorted by composite score (best first), plus the baseline
 * for comparison. Pure computation, no I/O.
 */

import type {
  ScoringConfig,
  HistoryRecord,
  TournamentEntry,
  BacktestResult,
  OptimizationSettings,
} from "./types";
import { DEFAULT_OPTIMIZATION_SETTINGS } from "./types";
import { backtest } from "./backtester";

export interface TournamentResult {
  baseline: TournamentEntry;
  candidates: TournamentEntry[];
  winner: TournamentEntry;
}

/**
 * Run a tournament: backtest the baseline and all candidates against history,
 * then rank by composite score.
 */
export function runTournament(
  baselineConfig: ScoringConfig,
  candidates: ScoringConfig[],
  history: HistoryRecord[],
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS,
): TournamentResult {
  const baselineResult = backtest(baselineConfig, history, settings);
  const baseline: TournamentEntry = { config: baselineConfig, result: baselineResult };

  const entries: TournamentEntry[] = candidates.map((config) => ({
    config,
    result: backtest(config, history, settings),
  }));

  // Sort by composite score descending
  entries.sort((a, b) => b.result.compositeScore - a.result.compositeScore);

  // Winner is the best candidate (may still lose to baseline in the ratchet)
  const winner = entries[0] ?? baseline;

  return { baseline, candidates: entries, winner };
}

/**
 * Format tournament results as a human-readable summary string.
 */
export function formatTournamentSummary(result: TournamentResult): string {
  const lines: string[] = [
    `Baseline composite: ${result.baseline.result.compositeScore.toFixed(3)}`,
  ];
  for (const entry of result.candidates.slice(0, 5)) {
    const marker = entry === result.winner ? " ← winner" : "";
    lines.push(
      `${entry.config.id}: ${entry.result.compositeScore.toFixed(3)}${marker}`,
    );
  }
  if (result.candidates.length > 5) {
    lines.push(`... and ${result.candidates.length - 5} more`);
  }
  return lines.join("\n");
}
