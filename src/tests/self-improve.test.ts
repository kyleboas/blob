import test from "node:test";
import assert from "node:assert/strict";
import { scoreItem, shouldFlag, classifySignal, extractContentSignals } from "../self-improve/scoring-engine";
import { backtest } from "../self-improve/backtester";
import { mutate, generateCandidates } from "../self-improve/mutator";
import { runTournament } from "../self-improve/tournament";
import { checkGates, ratchet } from "../self-improve/ratchet";
import { loadConfig, loadHistory, saveConfig, appendToHistory, runOptimizationCycle, diffConfigs, recordOutcome } from "../self-improve/index";
import { getExactKeywordCommand } from "../integrations/slack-commands";
import type { ScoringConfig, HistoryRecord, OptimizationSettings } from "../self-improve/types";
import { DEFAULT_SCORING_CONFIG, DEFAULT_OPTIMIZATION_SETTINGS } from "../self-improve/types";
import type { Env } from "../core/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class FakeObject {
  constructor(private body: string) {}
  async text(): Promise<string> { return this.body; }
  async json(): Promise<unknown> { return JSON.parse(this.body); }
}

class FakeR2Bucket {
  store = new Map<string, string>();
  async get(key: string): Promise<FakeObject | null> {
    const value = this.store.get(key);
    return value === undefined ? null : new FakeObject(value);
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(opts?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }> {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return { objects: keys.map((key) => ({ key })) };
  }
}

function makeConfig(overrides: Partial<ScoringConfig> = {}): ScoringConfig {
  return { ...DEFAULT_SCORING_CONFIG, ...overrides };
}

function makeHistory(count: number, outcomeRatio = 0.6): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (let i = 0; i < count; i++) {
    const contentLength = Math.random() * 100;
    const uniqueness = Math.random() * 100;
    const freshness = Math.random() * 100;
    const outcome = Math.random() < outcomeRatio;
    const score = contentLength * 0.3 + uniqueness * 0.4 + freshness * 0.3;
    records.push({
      id: `item-${i}`,
      scores: { contentLength, uniqueness, freshness },
      flagged: score >= 60,
      outcome,
      timestamp: new Date().toISOString(),
    });
  }
  return records;
}

function makeEnv(bucket?: FakeR2Bucket): Env {
  const store = bucket ?? new FakeR2Bucket();
  return {
    AGENT_DO: {
      idFromName: () => "blob-id" as DurableObjectId,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }) as DurableObjectStub,
    } as DurableObjectNamespace,
    SANDBOX: {
      start: async () => undefined,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      writeFile: async () => undefined,
      readFile: async () => "",
    },
    REPO_STORE: store as unknown as R2Bucket,
  } as Env;
}

// ---------------------------------------------------------------------------
// Scoring engine tests
// ---------------------------------------------------------------------------

test("scoreItem computes weighted sum minus penalties", () => {
  const config = makeConfig();
  const item = { contentLength: 100, uniqueness: 100, freshness: 100 };
  const score = scoreItem(item, config);
  // 100*0.3 + 100*0.4 + 100*0.3 = 100, no penalties
  assert.equal(score, 100);
});

test("scoreItem applies penalties for truthy flags", () => {
  const config = makeConfig();
  const item = { contentLength: 50, uniqueness: 50, freshness: 50, tooShort: true };
  const score = scoreItem(item, config);
  // 50*0.3 + 50*0.4 + 50*0.3 - 20 = 30
  assert.equal(score, 30);
});

test("scoreItem floors at zero", () => {
  const config = makeConfig();
  const item = { contentLength: 0, uniqueness: 0, freshness: 0, tooShort: true, duplicate: true };
  const score = scoreItem(item, config);
  assert.equal(score, 0);
});

test("shouldFlag returns true when score >= highSignal threshold", () => {
  const config = makeConfig();
  assert.equal(shouldFlag(60, config), true);
  assert.equal(shouldFlag(59, config), false);
});

test("classifySignal returns correct tier", () => {
  const config = makeConfig();
  assert.equal(classifySignal(70, config), "high");
  assert.equal(classifySignal(50, config), "medium");
  assert.equal(classifySignal(30, config), "low");
  assert.equal(classifySignal(10, config), "none");
});

// ---------------------------------------------------------------------------
// Backtester tests
// ---------------------------------------------------------------------------

test("backtest produces valid metrics", () => {
  const config = makeConfig();
  const history: HistoryRecord[] = [
    { id: "a", scores: { contentLength: 100, uniqueness: 100, freshness: 100 }, flagged: true, outcome: true, timestamp: "" },
    { id: "b", scores: { contentLength: 100, uniqueness: 100, freshness: 100 }, flagged: true, outcome: false, timestamp: "" },
    { id: "c", scores: { contentLength: 10, uniqueness: 10, freshness: 10 }, flagged: false, outcome: true, timestamp: "" },
    { id: "d", scores: { contentLength: 10, uniqueness: 10, freshness: 10 }, flagged: false, outcome: false, timestamp: "" },
  ];

  const result = backtest(config, history);
  assert.equal(result.truePositives, 1);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.missed, 1);
  assert.equal(result.trueNegatives, 1);
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 0.5);
  assert.equal(result.totalItems, 4);
});

test("backtest with empty history returns zeroes", () => {
  const config = makeConfig();
  const result = backtest(config, []);
  assert.equal(result.compositeScore, 0);
  assert.equal(result.totalItems, 0);
});

// ---------------------------------------------------------------------------
// Mutator tests
// ---------------------------------------------------------------------------

test("mutate produces a config with a different id", () => {
  const config = makeConfig();
  const candidate = mutate(config);
  assert.notEqual(candidate.id, config.id);
  assert.ok(candidate.id.startsWith("candidate-"));
});

test("mutate keeps values within bounds", () => {
  const config = makeConfig();
  for (let i = 0; i < 100; i++) {
    const c = mutate(config);
    assert.ok(c.thresholds.highSignal >= 50 && c.thresholds.highSignal <= 100,
      `highSignal ${c.thresholds.highSignal} out of bounds`);
    assert.ok(c.thresholds.medium >= 20 && c.thresholds.medium <= 80,
      `medium ${c.thresholds.medium} out of bounds`);
    assert.ok(c.thresholds.low >= 5 && c.thresholds.low <= 50,
      `low ${c.thresholds.low} out of bounds`);
    for (const w of Object.values(c.weights)) {
      assert.ok(w >= 0.05 && w <= 1.0, `weight ${w} out of bounds`);
    }
    for (const p of Object.values(c.penalties)) {
      assert.ok(p >= 0 && p <= 50, `penalty ${p} out of bounds`);
    }
  }
});

test("generateCandidates produces requested count", () => {
  const config = makeConfig();
  const candidates = generateCandidates(config, { ...DEFAULT_OPTIMIZATION_SETTINGS, candidatesPerCycle: 10 });
  assert.equal(candidates.length, 10);
});

// ---------------------------------------------------------------------------
// Tournament tests
// ---------------------------------------------------------------------------

test("runTournament ranks candidates by composite score", () => {
  const config = makeConfig();
  const history = makeHistory(30);
  const candidates = generateCandidates(config, { ...DEFAULT_OPTIMIZATION_SETTINGS, candidatesPerCycle: 5 });
  const result = runTournament(config, candidates, history);

  assert.equal(result.candidates.length, 5);
  // Verify sorted descending
  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(result.candidates[i - 1].result.compositeScore >= result.candidates[i].result.compositeScore);
  }
  // Winner should be the first candidate
  assert.equal(result.winner.config.id, result.candidates[0].config.id);
});

// ---------------------------------------------------------------------------
// Ratchet tests
// ---------------------------------------------------------------------------

test("ratchet rejects when history too small", () => {
  const config = makeConfig();
  const history: HistoryRecord[] = [
    { id: "a", scores: { contentLength: 100, uniqueness: 100, freshness: 100 }, flagged: true, outcome: true, timestamp: "" },
  ];
  const baseResult = backtest(config, history);
  const candidate = mutate(config);
  const candidateResult = backtest(candidate, history);

  const decision = ratchet(config, candidate, baseResult, candidateResult);
  assert.equal(decision.promoted, false);
  assert.ok(decision.rejectionReason?.includes("history"));
});

test("ratchet promotes when all gates pass", () => {
  const config = makeConfig({ thresholds: { highSignal: 90, medium: 50, low: 20 } });
  // Create history where lowering the threshold would capture more true positives
  const history: HistoryRecord[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({
      id: `item-${i}`,
      scores: { contentLength: 80 + i, uniqueness: 80 + i, freshness: 80 + i },
      flagged: false,
      outcome: true,
      timestamp: "",
    });
  }
  for (let i = 0; i < 10; i++) {
    history.push({
      id: `neg-${i}`,
      scores: { contentLength: 10, uniqueness: 10, freshness: 10 },
      flagged: false,
      outcome: false,
      timestamp: "",
    });
  }

  const baseResult = backtest(config, history);
  // A better config that lowers the threshold
  const betterConfig = makeConfig({
    id: "better",
    thresholds: { highSignal: 70, medium: 50, low: 20 },
  });
  const betterResult = backtest(betterConfig, history);

  const decision = ratchet(config, betterConfig, baseResult, betterResult);
  // If the better config actually improves, it should be promoted
  if (betterResult.compositeScore > baseResult.compositeScore + 0.005) {
    assert.equal(decision.promoted, true);
  }
});

test("checkGates returns correct gate results", () => {
  const baseResult = {
    configId: "base",
    truePositives: 5,
    falsePositives: 5,
    missed: 5,
    trueNegatives: 5,
    precision: 0.5,
    recall: 0.5,
    falsePositiveRate: 0.5,
    compositeScore: 0.5,
    totalItems: 20,
  };

  const candidateResult = {
    ...baseResult,
    configId: "candidate",
    precision: 0.3,
    compositeScore: 0.51,
  };

  const gates = checkGates(baseResult, candidateResult);
  const precisionGate = gates.find((g) => g.gate === "min-precision");
  assert.ok(precisionGate);
  assert.equal(precisionGate.passed, false);
});

// ---------------------------------------------------------------------------
// Integration tests (R2 storage)
// ---------------------------------------------------------------------------

test("loadConfig returns default when R2 is empty", async () => {
  const bucket = new FakeR2Bucket();
  const config = await loadConfig(bucket as unknown as R2Bucket);
  assert.equal(config.version, 1);
  assert.equal(config.thresholds.highSignal, 60);
});

test("saveConfig + loadConfig round-trips correctly", async () => {
  const bucket = new FakeR2Bucket();
  const config = makeConfig({ id: "test-v2", version: 2 });
  await saveConfig(bucket as unknown as R2Bucket, config);
  const loaded = await loadConfig(bucket as unknown as R2Bucket);
  assert.equal(loaded.id, "test-v2");
  assert.equal(loaded.version, 2);
});

test("appendToHistory + loadHistory round-trips correctly", async () => {
  const bucket = new FakeR2Bucket();
  const store = bucket as unknown as R2Bucket;
  const record: HistoryRecord = {
    id: "test-1",
    scores: { engagementScore: 75, qualityScore: 80 },
    flagged: true,
    outcome: true,
    timestamp: new Date().toISOString(),
  };

  await appendToHistory(store, record);
  await appendToHistory(store, { ...record, id: "test-2", outcome: false });

  const history = await loadHistory(store);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, "test-1");
  assert.equal(history[1].outcome, false);
});

test("runOptimizationCycle skips when history is too small", async () => {
  const env = makeEnv();
  const result = await runOptimizationCycle(env);
  assert.match(result, /skipped/);
  assert.match(result, /history records/);
});

test("runOptimizationCycle runs full cycle with enough history", async () => {
  const bucket = new FakeR2Bucket();
  const env = makeEnv(bucket);

  // Seed history with enough records
  const records = makeHistory(25, 0.5);
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  bucket.store.set("self-improve/history.jsonl", lines);

  const result = await runOptimizationCycle(env);
  assert.ok(result.includes("Self-improve:"));
  assert.ok(result.includes("Candidates tested:"));

  // Verify cycle log was written
  const logObj = bucket.store.get("self-improve/cycle-log.jsonl");
  assert.ok(logObj);
});

test("diffConfigs detects parameter changes", () => {
  const oldConfig = makeConfig();
  const newConfig = makeConfig({
    id: "new",
    thresholds: { highSignal: 55, medium: 40, low: 20 },
    weights: { contentLength: 0.4, uniqueness: 0.3, freshness: 0.3 },
  });
  const diffs = diffConfigs(oldConfig, newConfig);

  const highSignalDiff = diffs.find((d) => d.param === "thresholds.highSignal");
  assert.ok(highSignalDiff);
  assert.equal(highSignalDiff.oldValue, 60);
  assert.equal(highSignalDiff.newValue, 55);
  assert.ok(highSignalDiff.changePercent < 0); // decreased

  const contentDiff = diffs.find((d) => d.param === "weights.contentLength");
  assert.ok(contentDiff);
  assert.equal(contentDiff.oldValue, 0.3);
  assert.equal(contentDiff.newValue, 0.4);
});

// ---------------------------------------------------------------------------
// Content signal extraction tests
// ---------------------------------------------------------------------------

test("extractContentSignals returns high scores for substantial content", () => {
  const content = "A".repeat(500);
  const signals = extractContentSignals(content);
  assert.equal(signals.contentLength, 50); // 500/1000 * 100
  assert.equal(signals.uniqueness, 100);
  assert.equal(signals.freshness, 100);
  assert.equal(signals.tooShort, false);
  assert.equal(signals.duplicate, false);
});

test("extractContentSignals flags short content", () => {
  const signals = extractContentSignals("hi");
  assert.equal(signals.tooShort, true);
});

test("extractContentSignals detects duplicates via hash set", () => {
  const content = "some content to test";
  const hashes = new Set<string>();
  const first = extractContentSignals(content, hashes);
  assert.equal(first.duplicate, false);
  hashes.add(first._hash as string);

  const second = extractContentSignals(content, hashes);
  assert.equal(second.duplicate, true);
  assert.equal(second.uniqueness, 0);
});

// ---------------------------------------------------------------------------
// Outcome recording tests
// ---------------------------------------------------------------------------

test("recordOutcome updates matching history records", async () => {
  const bucket = new FakeR2Bucket();
  const store = bucket as unknown as R2Bucket;

  await appendToHistory(store, {
    id: "scan:news:1000",
    scores: { contentLength: 80, uniqueness: 100, freshness: 100 },
    flagged: true,
    outcome: false,
    timestamp: new Date().toISOString(),
  });
  await appendToHistory(store, {
    id: "scan:news:2000",
    scores: { contentLength: 60, uniqueness: 100, freshness: 100 },
    flagged: true,
    outcome: false,
    timestamp: new Date().toISOString(),
  });

  const updated = await recordOutcome(store, "scan:news:", true);
  assert.equal(updated, 2);

  const history = await loadHistory(store);
  assert.equal(history[0].outcome, true);
  assert.equal(history[1].outcome, true);
});

// ---------------------------------------------------------------------------
// Slack command tests
// ---------------------------------------------------------------------------

test("self-improve is recognized as an exact keyword command", () => {
  assert.equal(getExactKeywordCommand("self-improve"), "self-improve");
  assert.equal(getExactKeywordCommand("Self-Improve"), "self-improve");
  assert.equal(getExactKeywordCommand("  self-improve  "), "self-improve");
});

// ---------------------------------------------------------------------------
// Memory config integration tests
// ---------------------------------------------------------------------------

test("default config includes memory thresholds", () => {
  const config = DEFAULT_SCORING_CONFIG;
  assert.ok(config.memory);
  assert.equal(config.memory.maxTokensPerItem, 2000);
  assert.equal(config.memory.duplicateThreshold, 0.95);
  assert.equal(config.memory.recallMaxItems, 10);
  assert.equal(config.memory.recallMaxTokens, 4000);
});

test("loadConfig preserves memory thresholds", async () => {
  const bucket = new FakeR2Bucket();
  const store = bucket as unknown as R2Bucket;
  const config = { ...DEFAULT_SCORING_CONFIG, memory: { maxTokensPerItem: 3000, duplicateThreshold: 0.9, recallMaxItems: 15, recallMaxTokens: 5000 } };
  await saveConfig(store, config);
  const loaded = await loadConfig(store);
  assert.equal(loaded.memory?.maxTokensPerItem, 3000);
  assert.equal(loaded.memory?.duplicateThreshold, 0.9);
});
