import type { NormalizedError } from "../error-ingestion";
import type { ValidationRunResult } from "../validation/index";

export interface BuildPrBodyInput {
  error: NormalizedError;
  filesChanged: string[];
  validation: ValidationRunResult;
  attemptId: string;
  branchName: string;
}

export function buildPrBody(input: BuildPrBodyInput): string {
  const commandsSection = input.validation.checks
    .map((check) => `- ${check.name}: \`${check.command || "(not configured)"}\` → ${check.passed ? "pass" : "fail"}`)
    .join("\n");

  const outcomesSection = input.validation.checks
    .map((check) => `- ${check.name}: ${check.passed ? "✅" : "❌"} (${check.output || "no output"})`)
    .join("\n");

  const filesSection =
    input.filesChanged.length > 0
      ? input.filesChanged.map((file) => `- ${file}`).join("\n")
      : "- (no files)";

  return [
    "## Self-healing remediation summary",
    `- Attempt: ${input.attemptId}`,
    `- Branch: ${input.branchName}`,
    `- Repository: ${input.error.repository}`,
    `- Source: ${input.error.source}`,
    `- Error code: ${input.error.code}`,
    `- Message: ${input.error.message}`,
    "",
    "## Files changed",
    filesSection,
    "",
    "## Validation commands",
    commandsSection,
    "",
    "## Validation outcomes",
    outcomesSection
  ].join("\n");
}
