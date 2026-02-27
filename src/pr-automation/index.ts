import type { NormalizedError } from "../error-ingestion";
import type { ValidationRunResult } from "../validation/index";
import { buildPrBody } from "./pr-template";

export interface PullRequestPayload {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface PrAutomationAdapter {
  createBranch: (name: string) => Promise<void>;
  commitAll: (message: string) => Promise<string>;
  pushBranch: (name: string) => Promise<void>;
  openPullRequest: (payload: PullRequestPayload) => Promise<{ number: number; url: string }>;
}

export interface PrAutomationInput {
  error: NormalizedError;
  validation: ValidationRunResult;
  filesChanged: string[];
  timestamp: Date;
  attemptId: string;
  baseBranch?: string;
}

export interface PrAutomationResult {
  branchName: string;
  commitMessage: string;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

function sanitizeFingerprintPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24);
}

export function makeRemediationBranchName(error: NormalizedError, timestamp: Date): string {
  const fingerprint = [error.fingerprint.source, error.fingerprint.code, error.fingerprint.filePath]
    .map(sanitizeFingerprintPart)
    .filter(Boolean)
    .join("-");
  const datePart = timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `self-heal/${fingerprint}/${datePart}`;
}

export function makeCommitMessage(input: Pick<PrAutomationInput, "error" | "attemptId">): string {
  return `fix(self-heal): ${input.error.code} in ${input.error.filePath} (attempt ${input.attemptId})`;
}

export async function createRemediationPr(
  input: PrAutomationInput,
  adapter: PrAutomationAdapter
): Promise<PrAutomationResult> {
  if (!input.validation.passed || input.validation.blockedByRequiredCheck) {
    throw new Error("Validation failed; refusing to create PR");
  }

  const branchName = makeRemediationBranchName(input.error, input.timestamp);
  const commitMessage = makeCommitMessage(input);

  await adapter.createBranch(branchName);
  const commitSha = await adapter.commitAll(commitMessage);
  await adapter.pushBranch(branchName);

  const title = `Self-heal: ${input.error.code} (${input.error.source})`;
  const body = buildPrBody({
    error: input.error,
    filesChanged: input.filesChanged,
    validation: input.validation,
    attemptId: input.attemptId,
    branchName
  });

  const pullRequest = await adapter.openPullRequest({
    title,
    body,
    headBranch: branchName,
    baseBranch: input.baseBranch ?? "main"
  });

  return {
    branchName,
    commitMessage,
    commitSha,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url
  };
}
