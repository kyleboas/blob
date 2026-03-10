/**
 * mutator.ts — Generates random variations of a scoring config.
 *
 * Each mutation tweaks one parameter by ±mutationRange (default ±30%).
 * Values are clamped to their defined bounds. Pure computation, no I/O.
 */

import type { ScoringConfig, OptimizationSettings } from "./types";
import {
  DEFAULT_OPTIMIZATION_SETTINGS,
  PARAM_BOUNDS,
  WEIGHT_BOUNDS,
  PENALTY_BOUNDS,
} from "./types";

/** Deep-copy a config object. */
function deepCopy(config: ScoringConfig): ScoringConfig {
  return JSON.parse(JSON.stringify(config));
}

/** Clamp a value between min and max. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** All tunable parameter paths in a config. */
function getTunableParams(config: ScoringConfig): string[] {
  const params: string[] = [];
  for (const key of Object.keys(config.thresholds)) {
    params.push(`thresholds.${key}`);
  }
  for (const key of Object.keys(config.weights)) {
    params.push(`weights.${key}`);
  }
  for (const key of Object.keys(config.penalties)) {
    params.push(`penalties.${key}`);
  }
  return params;
}

/** Get the bounds for a parameter path. */
function getBounds(paramPath: string): { min: number; max: number } {
  if (PARAM_BOUNDS[paramPath]) return PARAM_BOUNDS[paramPath];
  if (paramPath.startsWith("weights.")) return WEIGHT_BOUNDS;
  if (paramPath.startsWith("penalties.")) return PENALTY_BOUNDS;
  return { min: 0, max: 100 };
}

/** Get a nested value from config by dot-separated path. */
function getParam(config: ScoringConfig, path: string): number {
  const [section, key] = path.split(".");
  const obj = config[section as keyof ScoringConfig];
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as Record<string, number>)[key];
  }
  return 0;
}

/** Set a nested value in config by dot-separated path. */
function setParam(config: ScoringConfig, path: string, value: number): void {
  const [section, key] = path.split(".");
  const obj = config[section as keyof ScoringConfig];
  if (typeof obj === "object" && obj !== null) {
    (obj as Record<string, number>)[key] = value;
  }
}

/** Generate a unique candidate ID. */
function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `candidate-${ts}-${rand}`;
}

/**
 * Create a single mutated variation of a config.
 * Picks one random parameter and adjusts it by ±mutationRange.
 */
export function mutate(
  baseConfig: ScoringConfig,
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS,
): ScoringConfig {
  const candidate = deepCopy(baseConfig);
  const params = getTunableParams(candidate);
  const param = params[Math.floor(Math.random() * params.length)];
  const currentValue = getParam(candidate, param);
  const delta = (Math.random() * 2 - 1) * settings.mutationRange;
  const bounds = getBounds(param);
  const newValue = clamp(
    currentValue * (1 + delta),
    bounds.min,
    bounds.max,
  );

  setParam(candidate, param, Math.round(newValue * 1000) / 1000);
  candidate.id = generateId();
  candidate.version = baseConfig.version;

  return candidate;
}

/**
 * Generate multiple candidate configs from a base.
 */
export function generateCandidates(
  baseConfig: ScoringConfig,
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS,
): ScoringConfig[] {
  const candidates: ScoringConfig[] = [];
  for (let i = 0; i < settings.candidatesPerCycle; i++) {
    candidates.push(mutate(baseConfig, settings));
  }
  return candidates;
}
