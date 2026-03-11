/**
 * propose-change.ts — Reads eval results and proposes a targeted improvement.
 *
 * Runs inside the Cloudflare Worker. Given eval results and key source files,
 * asks the LLM to propose a single targeted code change.
 */

import type { Env } from "../src/core/types";
import type { EvalOutput } from "./run-eval";

export interface Proposal {
  hypothesis: string;
  target_file?: string;
  change_type?: string;
  old_text?: string;
  new_text?: string;
  expected_improvement?: string;
  skip?: boolean;
}

const PROPOSER_PROMPT = `You are an AI researcher improving a coding agent. You analyze eval results and propose targeted code changes to improve performance.

## Rules

1. Propose exactly ONE change per experiment
2. The change must be small and targeted (one file, under 50 lines changed)
3. Focus on the lowest-scoring eval dimension or scenario
4. Do not propose changes that would break existing passing tests
5. Do not modify eval infrastructure (evals/ directory)
6. Only propose changes to files under src/

## Output Format

Respond with ONLY valid JSON:

{"hypothesis": "<what you think will improve and why>", "target_file": "<path relative to repo root>", "change_type": "edit", "old_text": "<exact text to replace>", "new_text": "<replacement text>", "expected_improvement": "<which eval scenario should improve>"}

If no improvement is needed (all scores >= 4), respond:

{"hypothesis": "no improvement needed", "skip": true}`;

async function callProposer(
  env: Env,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const baseUrl = (env.AI_GATEWAY_BASE_URL ?? "").replace(/\/$/, "");
  const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  const model = env.LLM_MODEL ?? "workers-ai/@cf/nvidia/nemotron-3-120b-a12b";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.AI_GATEWAY_TOKEN ?? ""}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Proposer call failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Gather key source files from the sandbox for context.
 */
async function gatherSourceContext(env: Env): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const keyPaths = [
    "/workspace/blob/src/agent/pi-agent.ts",
    "/workspace/blob/src/core/types.ts",
    "/workspace/blob/src/core/models.ts",
    "/workspace/blob/src/integrations/sandbox.ts",
    "/workspace/blob/src/core/safety.ts",
  ];

  for (const path of keyPaths) {
    try {
      const content = await env.SANDBOX.readFile(path);
      // Truncate to keep context manageable
      const relPath = path.replace("/workspace/blob/", "");
      files[relPath] = content.length > 4000 ? `${content.slice(0, 4000)}\n... (truncated)` : content;
    } catch {
      // File not available — skip
    }
  }

  return files;
}

/**
 * Propose a single targeted improvement based on eval results.
 */
export async function proposeChange(
  env: Env,
  evalResults: EvalOutput,
  experimentHistory: string,
): Promise<Proposal> {
  const sourceFiles = await gatherSourceContext(env);

  const response = await callProposer(env, [
    { role: "system", content: PROPOSER_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        eval_results: evalResults,
        source_files: sourceFiles,
        past_experiments: experimentHistory,
      }),
    },
  ]);

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in proposer response");
    return JSON.parse(jsonMatch[0]) as Proposal;
  } catch {
    return { hypothesis: "Failed to parse proposal", skip: true };
  }
}
