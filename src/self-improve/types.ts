/**
 * types.ts — Type definitions for the self-improving scoring config system.
 *
 * Implements the evolutionary optimization pattern: extract scoring rules into
 * a config, record outcomes, mutate configs, backtest against history, and
 * promote winners through quality gates (ratchet).
 */

/** A tunable scoring configuration that the agent reads at runtime. */
export interface ScoringConfig {
  version: number;
  id: string;
  thresholds: {
    highSignal: number;
    medium: number;
    low: number;
  };
  weights: Record<string, number>;
  penalties: Record<string, number>;
}

/** A single historical record: what the agent scored/flagged vs what actually happened. */
export interface HistoryRecord {
  id: string;
  /** Raw scores computed by the scoring engine at the time of flagging. */
  scores: Record<string, number>;
  /** Whether the agent flagged this item. */
  flagged: boolean;
  /** Whether the item actually turned out to be useful (ground truth). */
  outcome: boolean;
  timestamp: string;
}

/** Backtest metrics produced by replaying history against a candidate config. */
export interface BacktestResult {
  configId: string;
  truePositives: number;
  falsePositives: number;
  missed: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  compositeScore: number;
  totalItems: number;
}

/** A candidate config with its backtest result, used in tournaments. */
export interface TournamentEntry {
  config: ScoringConfig;
  result: BacktestResult;
}

/** Quality gate check result. */
export interface GateResult {
  gate: string;
  passed: boolean;
  reason: string;
  value?: number;
  threshold?: number;
}

/** Ratchet decision: whether to promote a candidate config. */
export interface RatchetDecision {
  promoted: boolean;
  candidate: ScoringConfig;
  baselineResult: BacktestResult;
  candidateResult: BacktestResult;
  gates: GateResult[];
  rejectionReason?: string;
}

/** A single parameter change between old and new config. */
export interface ConfigDiffEntry {
  param: string;
  oldValue: number;
  newValue: number;
  changePercent: number;
}

/** Full cycle result for logging and observability. */
export interface OptimizationCycleResult {
  timestamp: string;
  candidatesGenerated: number;
  baselineComposite: number;
  bestCandidateComposite: number;
  promoted: boolean;
  promotedConfigId?: string;
  promotedVersion?: number;
  configDiff?: ConfigDiffEntry[];
  gates: GateResult[];
  rejectionReason?: string;
}

/** Bounds for a tunable parameter. */
export interface ParamBounds {
  min: number;
  max: number;
}

/** Configuration for the optimization cycle itself. */
export interface OptimizationSettings {
  candidatesPerCycle: number;
  mutationRange: number;
  compositeWeights: {
    precision: number;
    recall: number;
    efficiency: number;
  };
  gates: {
    minPrecision: number;
    maxFalsePositiveRate: number;
    minImprovement: number;
    minHistorySize: number;
  };
}

export const DEFAULT_OPTIMIZATION_SETTINGS: OptimizationSettings = {
  candidatesPerCycle: 20,
  mutationRange: 0.3,
  compositeWeights: {
    precision: 0.5,
    recall: 0.3,
    efficiency: 0.2,
  },
  gates: {
    minPrecision: 0.5,
    maxFalsePositiveRate: 0.4,
    minImprovement: 0.005,
    minHistorySize: 15,
  },
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: 1,
  id: "default-v1",
  thresholds: {
    highSignal: 80,
    medium: 50,
    low: 20,
  },
  weights: {
    engagementScore: 0.4,
    qualityScore: 0.6,
  },
  penalties: {
    noiseKeywords: 15,
    staleContent: 10,
  },
};

/** Bounds for each tunable parameter family. */
export const PARAM_BOUNDS: Record<string, ParamBounds> = {
  "thresholds.highSignal": { min: 50, max: 100 },
  "thresholds.medium": { min: 20, max: 80 },
  "thresholds.low": { min: 5, max: 50 },
};

export const WEIGHT_BOUNDS: ParamBounds = { min: 0.05, max: 1.0 };
export const PENALTY_BOUNDS: ParamBounds = { min: 0, max: 50 };
