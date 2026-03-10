/**
 * index.ts — Self-improving scoring config orchestrator.
 *
 * Runs the full optimization cycle:
 * 1. Load current config + history from R2
 * 2. Generate mutated candidates
 * 3. Run tournament (backtest all against history)
 * 4. Apply ratchet (quality gates)
 * 5. If promoted, archive old config and write new one
 * 6. Log the cycle result
 *
 * No LLM calls — pure JS computation. Designed to run as a cron job.
 */

import type { Env } from "../core/types";
import type {
  ScoringConfig,
  HistoryRecord,
  OptimizationSettings,
  OptimizationCycleResult,
  ConfigDiffEntry,
} from "./types";
import { DEFAULT_SCORING_CONFIG, DEFAULT_OPTIMIZATION_SETTINGS } from "./types";
import { generateCandidates } from "./mutator";
import { runTournament, formatTournamentSummary } from "./tournament";
import { ratchet } from "./ratchet";

const CONFIG_KEY = "self-improve/scoring-config.json";
const HISTORY_KEY = "self-improve/history.jsonl";
const SETTINGS_KEY = "self-improve/settings.json";
const LOG_KEY = "self-improve/cycle-log.jsonl";

/** Load the current scoring config from R2, or return the default. */
export async function loadConfig(store: R2Bucket): Promise<ScoringConfig> {
  const obj = await store.get(CONFIG_KEY);
  if (obj) {
    try {
      return (await obj.json()) as ScoringConfig;
    } catch {
      // Fall through to default
    }
  }
  return { ...DEFAULT_SCORING_CONFIG };
}

/** Save the active scoring config to R2. */
export async function saveConfig(store: R2Bucket, config: ScoringConfig): Promise<void> {
  await store.put(CONFIG_KEY, JSON.stringify(config, null, 2));
}

/** Archive a config version to R2 config history. */
async function archiveConfig(store: R2Bucket, config: ScoringConfig): Promise<void> {
  const key = `self-improve/config-history/config-v${config.version}.json`;
  await store.put(key, JSON.stringify(config, null, 2));
}

/** Load history records from R2 (JSONL format). */
export async function loadHistory(store: R2Bucket): Promise<HistoryRecord[]> {
  const obj = await store.get(HISTORY_KEY);
  if (!obj) return [];

  const text = await obj.text();
  const records: HistoryRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as HistoryRecord);
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

/** Append a single outcome record to the history file. */
export async function appendToHistory(
  store: R2Bucket,
  record: HistoryRecord,
): Promise<void> {
  const existing = await store.get(HISTORY_KEY);
  const prev = existing ? await existing.text() : "";
  const line = JSON.stringify(record);
  await store.put(HISTORY_KEY, prev ? `${prev}\n${line}` : line);
}

/** Load optimization settings from R2, or return defaults. */
async function loadSettings(store: R2Bucket): Promise<OptimizationSettings> {
  const obj = await store.get(SETTINGS_KEY);
  if (obj) {
    try {
      return (await obj.json()) as OptimizationSettings;
    } catch {
      // Fall through to default
    }
  }
  return { ...DEFAULT_OPTIMIZATION_SETTINGS };
}

/** Append a cycle result to the log file. */
async function logCycleResult(
  store: R2Bucket,
  result: OptimizationCycleResult,
): Promise<void> {
  const existing = await store.get(LOG_KEY);
  const prev = existing ? await existing.text() : "";
  const line = JSON.stringify(result);
  await store.put(LOG_KEY, prev ? `${prev}\n${line}` : line);
}

/** Compute what changed between old and new config. */
export function diffConfigs(oldConfig: ScoringConfig, newConfig: ScoringConfig): ConfigDiffEntry[] {
  const diffs: ConfigDiffEntry[] = [];

  const sections: Array<"thresholds" | "weights" | "penalties"> = ["thresholds", "weights", "penalties"];
  for (const section of sections) {
    const oldSection = oldConfig[section] as Record<string, number>;
    const newSection = newConfig[section] as Record<string, number>;
    for (const key of new Set([...Object.keys(oldSection), ...Object.keys(newSection)])) {
      const oldVal = oldSection[key] ?? 0;
      const newVal = newSection[key] ?? 0;
      if (oldVal !== newVal) {
        const changePercent = oldVal !== 0 ? ((newVal - oldVal) / oldVal) * 100 : 100;
        diffs.push({
          param: `${section}.${key}`,
          oldValue: oldVal,
          newValue: newVal,
          changePercent: Math.round(changePercent * 10) / 10,
        });
      }
    }
  }
  return diffs;
}

/** Format a config diff as a readable string. */
function formatDiff(diffs: ConfigDiffEntry[]): string {
  if (diffs.length === 0) return "No parameter changes";
  return diffs
    .map((d) => {
      const arrow = d.changePercent > 0 ? "↑" : "↓";
      return `${d.param}: ${d.oldValue} → ${d.newValue} (${arrow}${Math.abs(d.changePercent)}%)`;
    })
    .join("\n");
}

/**
 * Run a full self-improvement optimization cycle.
 * Returns a human-readable summary string suitable for cron output.
 */
export async function runOptimizationCycle(env: Env): Promise<string> {
  const store = env.REPO_STORE;

  // 1. Load current state
  const config = await loadConfig(store);
  const history = await loadHistory(store);
  const settings = await loadSettings(store);

  // Early exit: not enough history
  if (history.length < settings.gates.minHistorySize) {
    const result: OptimizationCycleResult = {
      timestamp: new Date().toISOString(),
      candidatesGenerated: 0,
      baselineComposite: 0,
      bestCandidateComposite: 0,
      promoted: false,
      gates: [],
      rejectionReason: `Only ${history.length} history records (need >= ${settings.gates.minHistorySize})`,
    };
    await logCycleResult(store, result);
    return `Self-improve: skipped — only ${history.length} history records (need >= ${settings.gates.minHistorySize})`;
  }

  // 2. Generate candidates
  const candidates = generateCandidates(config, settings);

  // 3. Run tournament
  const tournament = runTournament(config, candidates, history, settings);

  // 4. Apply ratchet
  const decision = ratchet(
    config,
    tournament.winner.config,
    tournament.baseline.result,
    tournament.winner.result,
    settings,
  );

  // 5. Promote or reject
  let configDiff: ConfigDiffEntry[] = [];
  let newVersion = config.version;
  if (decision.promoted) {
    const newConfig = {
      ...tournament.winner.config,
      version: config.version + 1,
    };
    newVersion = newConfig.version;
    configDiff = diffConfigs(config, newConfig);

    await archiveConfig(store, config);
    await saveConfig(store, newConfig);
  }

  // 6. Log the cycle
  const cycleResult: OptimizationCycleResult = {
    timestamp: new Date().toISOString(),
    candidatesGenerated: candidates.length,
    baselineComposite: tournament.baseline.result.compositeScore,
    bestCandidateComposite: tournament.winner.result.compositeScore,
    promoted: decision.promoted,
    promotedConfigId: decision.promoted ? tournament.winner.config.id : undefined,
    promotedVersion: decision.promoted ? newVersion : undefined,
    configDiff: decision.promoted ? configDiff : undefined,
    gates: decision.gates,
    rejectionReason: decision.rejectionReason,
  };
  await logCycleResult(store, cycleResult);

  // 7. Build human-readable summary
  const br = tournament.baseline.result;
  const wr = tournament.winner.result;

  if (decision.promoted) {
    const diffText = formatDiff(configDiff);
    return [
      `Self-improve: PROMOTED (v${config.version} → v${newVersion})`,
      `Composite: ${br.compositeScore.toFixed(3)} → ${wr.compositeScore.toFixed(3)}`,
      `Precision: ${br.precision.toFixed(3)} → ${wr.precision.toFixed(3)}`,
      `Recall: ${br.recall.toFixed(3)} → ${wr.recall.toFixed(3)}`,
      `FP rate: ${br.falsePositiveRate.toFixed(3)} → ${wr.falsePositiveRate.toFixed(3)}`,
      `What changed:\n${diffText}`,
      `History: ${history.length} records, Candidates tested: ${candidates.length}`,
    ].join("\n");
  }

  return [
    `Self-improve: REJECTED — ${decision.rejectionReason}`,
    `Baseline: ${br.compositeScore.toFixed(3)}, Best candidate: ${wr.compositeScore.toFixed(3)}`,
    `History: ${history.length} records, Candidates tested: ${candidates.length}`,
  ].join("\n");
}
