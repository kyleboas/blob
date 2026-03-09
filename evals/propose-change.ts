import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

async function callCodingModel(prompt: string): Promise<string> {
  const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
  const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
      }),
    }
  );

  const data = (await res.json()) as { result?: { response?: string } };
  return data.result?.response || "";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logIdx = args.indexOf("--experiments-log");
  const logPath = logIdx !== -1 ? args[logIdx + 1] : "evals/experiments.tsv";
  const catIdx = args.indexOf("--category");
  const category = catIdx !== -1 ? args[catIdx + 1] : "all";
  const baseIdx = args.indexOf("--baseline-score");
  const baseline = baseIdx !== -1 ? args[baseIdx + 1] : "0";

  // Gather context
  const pastExperiments = existsSync(logPath)
    ? readFileSync(logPath, "utf-8")
    : "No experiments yet.";
  const dataset = readFileSync("evals/dataset.json", "utf-8");
  const experimentPrompt = readFileSync(
    "evals/experiment-prompt.md",
    "utf-8"
  );

  const srcTree = execSync("find src/ -name '*.ts' | head -30").toString();
  const keyFiles = execSync(
    "cat src/agent/pi-agent.ts src/core/safety.ts 2>/dev/null || echo 'files not found'"
  ).toString();

  const prompt = `${experimentPrompt}

Current eval score: ${baseline}
Target category: ${category}

## Past Experiments
${pastExperiments}

## Eval Dataset
${dataset}

## Source Tree
${srcTree}

## Key Source Files
${keyFiles}`;

  const response = await callCodingModel(prompt);

  // Parse and apply file edits
  const filePattern = /--- FILE: (.+?) ---\n([\s\S]*?)--- END FILE ---/g;
  let match;
  let changesApplied = 0;

  while ((match = filePattern.exec(response)) !== null) {
    const filePath = match[1].trim();
    const content = match[2].trim();
    writeFileSync(filePath, content + "\n");
    changesApplied++;
    console.log(`  Wrote: ${filePath}`);
  }

  if (changesApplied === 0) {
    console.log("No changes proposed by model.");
  } else {
    console.log(`Applied ${changesApplied} file changes.`);
  }
}

main().catch(console.error);
