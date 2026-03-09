import { readFileSync } from "fs";

interface EvalScenario {
  id: string;
  category: string;
  input: { channel: string; user: string; text?: string; messages?: string[] };
  setup?: {
    sandbox_files?: Record<string, string>;
    sandbox_commands?: string[];
  };
  expected: Record<string, unknown>;
  followup?: { text: string };
  weight: number;
}

interface JudgeScore {
  correctness: number;
  tool_usage: number;
  safety: number;
  communication: number;
  overall: number;
  reasoning: string;
}

const BLOB_PREVIEW_URL =
  process.env.BLOB_PREVIEW_URL ||
  "https://blob-agent-preview.workers.dev";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const JUDGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function setupSandbox(scenario: EvalScenario): Promise<void> {
  if (scenario.setup?.sandbox_files) {
    for (const [path, content] of Object.entries(
      scenario.setup.sandbox_files
    )) {
      await fetch(`${BLOB_PREVIEW_URL}/eval/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CF_API_TOKEN}`,
        },
        body: JSON.stringify({ action: "write_file", path, content }),
      });
    }
  }

  if (scenario.setup?.sandbox_commands) {
    for (const cmd of scenario.setup.sandbox_commands) {
      await fetch(`${BLOB_PREVIEW_URL}/eval/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CF_API_TOKEN}`,
        },
        body: JSON.stringify({ action: "run_command", command: cmd }),
      });
    }
  }
}

async function sendMessages(
  scenario: EvalScenario
): Promise<Record<string, unknown>> {
  const messages = scenario.input.messages || [scenario.input.text!];
  let lastResponse: Record<string, unknown> = {};

  for (const text of messages) {
    const res = await fetch(`${BLOB_PREVIEW_URL}/eval/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        channel: scenario.input.channel,
        user: scenario.input.user,
        text,
      }),
    });
    lastResponse = (await res.json()) as Record<string, unknown>;

    if (messages.length > 1) await sleep(2000);
  }

  // Handle followup messages (e.g., memory recall)
  if (scenario.followup) {
    await sleep(2000);
    const res = await fetch(`${BLOB_PREVIEW_URL}/eval/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        channel: scenario.input.channel,
        user: scenario.input.user,
        text: scenario.followup.text,
      }),
    });
    lastResponse = (await res.json()) as Record<string, unknown>;
  }

  return lastResponse;
}

async function getSandboxState(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BLOB_PREVIEW_URL}/eval/state`, {
    headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

async function scoreWithJudge(
  judgePrompt: string,
  scenario: EvalScenario,
  blobOutput: Record<string, unknown>,
  sandboxState: Record<string, unknown>
): Promise<JudgeScore> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${JUDGE_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: judgePrompt },
          {
            role: "user",
            content: JSON.stringify({
              scenario: {
                id: scenario.id,
                input: scenario.input,
                expected: scenario.expected,
              },
              actual_output: blobOutput,
              sandbox_state: sandboxState,
            }),
          },
        ],
      }),
    }
  );

  const data = (await res.json()) as { result?: { response?: string } };
  const text = data.result?.response || "";

  try {
    return JSON.parse(text) as JudgeScore;
  } catch {
    return {
      correctness: 0,
      tool_usage: 0,
      safety: 0,
      communication: 0,
      overall: 0,
      reasoning: "Judge parse error",
    };
  }
}

async function runScenario(
  scenario: EvalScenario,
  judgePrompt: string
): Promise<{
  scenario_id: string;
  output: Record<string, unknown>;
  score: JudgeScore;
}> {
  await setupSandbox(scenario);
  const output = await sendMessages(scenario);
  const sandboxState = await getSandboxState();
  const score = await scoreWithJudge(
    judgePrompt,
    scenario,
    output,
    sandboxState
  );

  return { scenario_id: scenario.id, output, score };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const categoryIdx = args.indexOf("--category");
  const category = categoryIdx !== -1 ? args[categoryIdx + 1] : "all";

  const dataset: EvalScenario[] = JSON.parse(
    readFileSync("evals/dataset.json", "utf-8")
  );
  const scenarios =
    category === "all"
      ? dataset
      : dataset.filter((s) => s.category === category);

  const judgePrompt = readFileSync("evals/judge-prompt.md", "utf-8");

  console.log(`Running ${scenarios.length} scenarios (category: ${category})`);

  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const scenario of scenarios) {
    try {
      const result = await runScenario(scenario, judgePrompt);
      const weighted = result.score.overall * scenario.weight;
      totalWeightedScore += weighted;
      totalWeight += scenario.weight;

      console.log(
        `  ${scenario.id}: ${result.score.overall.toFixed(2)} (${result.score.reasoning})`
      );
    } catch (err) {
      console.error(`  ${scenario.id}: ERROR - ${err}`);
      totalWeight += scenario.weight;
    }
  }

  const finalScore =
    totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
  console.log(`\nFinal weighted score: ${finalScore.toFixed(4)}`);

  // Last line is parsed by the shell script
  console.log(finalScore.toFixed(4));
}

main().catch(console.error);
