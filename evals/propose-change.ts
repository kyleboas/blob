/**
 * propose-change.ts — Reads eval results and proposes a targeted improvement.
 *
 * Invoked by the autoresearch cron task via:
 *   node --experimental-strip-types evals/propose-change.ts
 *
 * Expects env vars:
 *   AI_GATEWAY_BASE_URL, AI_GATEWAY_TOKEN — for LLM calls
 *   EVAL_PROPOSER_MODEL — model for proposals (defaults to Llama 3.3)
 *
 * Reads evals/results.json and key source files, asks the LLM to propose
 * a change, and writes the proposal to evals/proposal.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const GATEWAY_URL = process.env.AI_GATEWAY_BASE_URL ?? "";
const GATEWAY_TOKEN = process.env.AI_GATEWAY_TOKEN ?? "";
const PROPOSER_MODEL = process.env.EVAL_PROPOSER_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WORKSPACE = "/workspace/blob";

interface Proposal {
  hypothesis: string;
  target_file?: string;
  change_type?: string;
  old_text?: string;
  new_text?: string;
  expected_improvement?: string;
  skip?: boolean;
}

async function callModel(messages: Array<{ role: string; content: string }>, maxTokens = 4096): Promise<string> {
  const url = GATEWAY_URL.endsWith("/chat/completions")
    ? GATEWAY_URL
    : `${GATEWAY_URL.replace(/\/$/, "")}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ model: PROPOSER_MODEL, messages, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Model call failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "(file not found)";
  }
}

async function main() {
  const resultsPath = `${WORKSPACE}/evals/results.json`;
  if (!existsSync(resultsPath)) {
    console.error("No eval results found. Run evals/run-eval.ts first.");
    process.exit(1);
  }

  const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
  const experimentPrompt = readFileSync(`${WORKSPACE}/evals/experiment-prompt.md`, "utf-8");
  const experiments = readFileSafe(`${WORKSPACE}/evals/experiments.tsv`);

  // Gather key source files for context
  const sourceFiles: Record<string, string> = {};
  const keyFiles = [
    "src/agent/pi-agent.ts",
    "src/core/llm.ts",
    "src/core/types.ts",
    "src/integrations/sandbox.ts",
    "src/jobs/cron-jobs.ts",
  ];

  for (const file of keyFiles) {
    const content = readFileSafe(`${WORKSPACE}/${file}`);
    if (content !== "(file not found)") {
      // Truncate large files to keep context manageable
      sourceFiles[file] = content.length > 3000 ? `${content.slice(0, 3000)}\n... (truncated)` : content;
    }
  }

  const response = await callModel([
    { role: "system", content: experimentPrompt },
    {
      role: "user",
      content: JSON.stringify({
        eval_results: results,
        source_files: sourceFiles,
        past_experiments: experiments,
      }),
    },
  ]);

  let proposal: Proposal;
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in proposer response");
    proposal = JSON.parse(jsonMatch[0]) as Proposal;
  } catch {
    proposal = { hypothesis: "Failed to parse proposal", skip: true };
  }

  writeFileSync(`${WORKSPACE}/evals/proposal.json`, JSON.stringify(proposal, null, 2));
  console.log(`Proposal: ${proposal.hypothesis}`);

  if (proposal.skip) {
    console.log("PROPOSAL_SKIP=true");
  } else {
    console.log(`PROPOSAL_FILE=${proposal.target_file}`);
    console.log("PROPOSAL_SKIP=false");
  }
}

main().catch((err) => {
  console.error("Propose failed:", err);
  process.exit(1);
});
