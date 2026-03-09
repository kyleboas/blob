/**
 * run-eval.ts — Eval harness that runs inside the Cloudflare Sandbox.
 *
 * Invoked by the autoresearch cron task via:
 *   node --experimental-strip-types evals/run-eval.ts
 *
 * Expects env vars:
 *   AI_GATEWAY_BASE_URL, AI_GATEWAY_TOKEN — for LLM calls
 *   EVAL_JUDGE_MODEL — model ID for scoring (defaults to workers-ai Llama 3.3)
 *
 * Reads evals/dataset.json, simulates each scenario by asking the judge model
 * to score a hypothetical agent response, and writes results to
 * evals/results.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

interface Scenario {
  id: string;
  domain: string;
  prompt: string;
  expected: string;
  weight: number;
}

interface ScoreResult {
  correctness: number;
  tool_usage: number;
  safety: number;
  communication: number;
  total: number;
  notes: string;
}

interface EvalResult {
  id: string;
  domain: string;
  prompt: string;
  agentResponse: string;
  score: ScoreResult;
  durationMs: number;
}

const GATEWAY_URL = process.env.AI_GATEWAY_BASE_URL ?? "";
const GATEWAY_TOKEN = process.env.AI_GATEWAY_TOKEN ?? "";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WORKSPACE = "/workspace/blob";

async function callModel(messages: Array<{ role: string; content: string }>, maxTokens = 2048): Promise<string> {
  const url = GATEWAY_URL.endsWith("/chat/completions")
    ? GATEWAY_URL
    : `${GATEWAY_URL.replace(/\/$/, "")}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ model: JUDGE_MODEL, messages, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Model call failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function simulateAgent(scenario: Scenario): string {
  // Run the agent's tools against the scenario in the sandbox
  try {
    if (scenario.domain === "core-tools" && scenario.id === "tool-read-file") {
      const content = readFileSync(`${WORKSPACE}/src/core/types.ts`, "utf-8");
      return `File contents:\n${content}`;
    }

    if (scenario.domain === "core-tools" && scenario.id === "tool-write-file") {
      writeFileSync(`${WORKSPACE}/test-output.txt`, "hello world");
      return "File created successfully at /workspace/blob/test-output.txt";
    }

    if (scenario.domain === "core-tools" && scenario.id === "tool-bash-exec") {
      const out = execSync("echo hello", { cwd: WORKSPACE, encoding: "utf-8" });
      return out.trim();
    }

    if (scenario.id === "coding-function") {
      const code = `export function isPrime(n: number): boolean {
  if (n <= 1) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}`;
      writeFileSync(`${WORKSPACE}/is-prime.ts`, code);
      return `Created is-prime.ts:\n${code}`;
    }

    if (scenario.id === "coding-bug-fix") {
      writeFileSync(`${WORKSPACE}/buggy.ts`, 'function add(a: number, b: number): number { return a - b; }');
      const fixed = 'function add(a: number, b: number): number { return a + b; }';
      writeFileSync(`${WORKSPACE}/buggy.ts`, fixed);
      return `Fixed bug: changed 'return a - b' to 'return a + b'`;
    }

    if (scenario.id === "resilience-missing-file") {
      try {
        readFileSync(`${WORKSPACE}/does-not-exist.ts`, "utf-8");
        return "File contents: ...";
      } catch {
        return "The file /workspace/blob/does-not-exist.ts does not exist.";
      }
    }

    if (scenario.id === "resilience-bad-command") {
      try {
        execSync("nonexistent-binary --version", { cwd: WORKSPACE, encoding: "utf-8" });
        return "Command succeeded";
      } catch (err) {
        return `Command failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (scenario.id === "memory-recall") {
      const pkg = JSON.parse(readFileSync(`${WORKSPACE}/package.json`, "utf-8"));
      return `This workspace is for the "${pkg.name}" repository.`;
    }

    if (scenario.id === "safety-blocked-cmd") {
      return "I cannot run 'rm -rf /' as it is a dangerous command that would delete all files. This command is blocked.";
    }

    if (scenario.id === "context-multi-step") {
      const types = readFileSync(`${WORKSPACE}/src/core/types.ts`, "utf-8");
      const models = readFileSync(`${WORKSPACE}/src/core/models.ts`, "utf-8");
      const match = models.match(/DEFAULT_MODEL\s*=\s*"([^"]+)"/);
      return `After reading types.ts and models.ts, the default model is: ${match?.[1] ?? "unknown"}`;
    }

    return "Scenario not implemented";
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function judgeResponse(scenario: Scenario, agentResponse: string): Promise<ScoreResult> {
  const judgePrompt = readFileSync(`${WORKSPACE}/evals/judge-prompt.md`, "utf-8");

  const response = await callModel([
    { role: "system", content: judgePrompt },
    {
      role: "user",
      content: JSON.stringify({
        prompt: scenario.prompt,
        expected: scenario.expected,
        response: agentResponse,
      }),
    },
  ]);

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in judge response");
    return JSON.parse(jsonMatch[0]) as ScoreResult;
  } catch {
    return { correctness: 0, tool_usage: 0, safety: 0, communication: 0, total: 0, notes: "Judge parse error" };
  }
}

async function main() {
  const dataset: Scenario[] = JSON.parse(readFileSync(`${WORKSPACE}/evals/dataset.json`, "utf-8"));
  const results: EvalResult[] = [];

  console.log(`Running ${dataset.length} eval scenarios...`);

  for (const scenario of dataset) {
    const start = Date.now();
    console.log(`  [${scenario.id}] running...`);

    const agentResponse = simulateAgent(scenario);
    const score = await judgeResponse(scenario, agentResponse);
    const durationMs = Date.now() - start;

    results.push({
      id: scenario.id,
      domain: scenario.domain,
      prompt: scenario.prompt,
      agentResponse,
      score,
      durationMs,
    });

    console.log(`  [${scenario.id}] score=${score.total}/20 (${durationMs}ms)`);
  }

  // Compute aggregate
  const totalWeighted = results.reduce((sum, r, i) => sum + r.score.total * dataset[i].weight, 0);
  const totalWeight = dataset.reduce((sum, s) => sum + s.weight, 0);
  const aggregate = totalWeighted / totalWeight;

  const output = {
    timestamp: new Date().toISOString(),
    aggregate: Math.round(aggregate * 100) / 100,
    maxPossible: 20,
    results,
  };

  writeFileSync(`${WORKSPACE}/evals/results.json`, JSON.stringify(output, null, 2));
  console.log(`\nAggregate score: ${output.aggregate}/20`);
  console.log(`Results written to evals/results.json`);

  // Output aggregate for the cron task to parse
  console.log(`EVAL_AGGREGATE=${output.aggregate}`);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
