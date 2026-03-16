import type { Env } from "../core/types";
import { executeInSandbox } from "../integrations/sandbox";
import { GitHubApi, buildPrIdempotencyKey, scanDiffForSecrets } from "../integrations/github";
import { detectVerificationCommand, repoDirFromSlug } from "./repo-diagnosis";

export type AutonomousPullRequestResult =
  | { status: "opened"; url: string; number: number; branch: string; verificationCommand?: string }
  | { status: "skipped"; reason: string; verificationCommand?: string };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function summarizeText(text: string, maxChars = 500): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function getGitEnvVars(env: Env): Record<string, string> | undefined {
  if (!env.GITHUB_TOKEN) return undefined;
  return {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function ensureRepoReady(env: Env, repo: string, sandboxId: string): Promise<string> {
  const repoDir = repoDirFromSlug(repo);
  const workspaceRoot = `/workspace/${repoDir}`;
  const result = await executeInSandbox("test -d .git", env, {
    sandboxId,
    workspaceRoot,
    timeout: 30000,
    envVars: getGitEnvVars(env),
  });
  if (result.exitCode !== 0) {
    throw new Error(`repo workspace not ready for PR creation: ${summarizeText(result.stderr || result.stdout || "missing .git")}`);
  }
  return workspaceRoot;
}

async function getBaseBranch(env: Env, workspaceRoot: string, sandboxId: string): Promise<string> {
  const result = await executeInSandbox(
    "git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'",
    env,
    { sandboxId, workspaceRoot, timeout: 30000, envVars: getGitEnvVars(env) },
  );
  const branch = result.stdout.trim();
  return branch || "main";
}

function buildPullRequestBody(params: {
  repo: string;
  task: string;
  jobId: string;
  summary?: string;
  verificationCommand?: string;
}): string {
  const lines = [
    "Automated background improvement from Blob.",
    "",
    `Repo: ${params.repo}`,
    `Job: ${params.jobId}`,
    `Task: ${params.task}`,
  ];
  if (params.verificationCommand) lines.push(`Verification: \`${params.verificationCommand}\``);
  if (params.summary) {
    lines.push("", "Diagnosis summary:", params.summary);
  }
  return lines.join("\n");
}

export async function maybeOpenAutonomousPullRequest(params: {
  env: Env;
  repo: string;
  task: string;
  jobId: string;
  sandboxId: string;
  diagnosisSummary?: string;
}): Promise<AutonomousPullRequestResult> {
  const { env, repo, task, jobId, sandboxId, diagnosisSummary } = params;
  if (env.AUTONOMOUS_PR_ENABLED === "false") {
    return { status: "skipped", reason: "autonomous PRs disabled" };
  }
  if (!env.GITHUB_TOKEN) {
    return { status: "skipped", reason: "missing GITHUB_TOKEN" };
  }
  if (!repo.includes("/")) {
    return { status: "skipped", reason: "repo slug is not GitHub-compatible" };
  }

  const workspaceRoot = await ensureRepoReady(env, repo, sandboxId);
  const verificationCommand = await detectVerificationCommand(env, repo, sandboxId);
  if (verificationCommand) {
    const verification = await executeInSandbox(verificationCommand, env, {
      sandboxId,
      workspaceRoot,
      timeout: 180000,
      envVars: getGitEnvVars(env),
    });
    if (verification.exitCode !== 0) {
      return {
        status: "skipped",
        reason: `verification failed: ${summarizeText([verification.stdout, verification.stderr].filter(Boolean).join("\n"))}`,
        verificationCommand,
      };
    }
  }

  await executeInSandbox(
    "git checkout -- .blob/memory/context.md .blob/memory/journal.md 2>/dev/null || true; rm -rf .blob/scratch 2>/dev/null || true",
    env,
    { sandboxId, workspaceRoot, timeout: 30000, envVars: getGitEnvVars(env) },
  );

  const statusBefore = await executeInSandbox("git status --porcelain", env, {
    sandboxId,
    workspaceRoot,
    timeout: 30000,
    envVars: getGitEnvVars(env),
  });
  if (!statusBefore.stdout.trim()) {
    return { status: "skipped", reason: "no code changes to open a PR for", verificationCommand };
  }

  const baseBranch = await getBaseBranch(env, workspaceRoot, sandboxId);
  const branch = `blob-autonomy/${jobId.slice(0, 12)}`;

  await executeInSandbox(`git checkout -B ${shellQuote(branch)}`, env, {
    sandboxId,
    workspaceRoot,
    timeout: 30000,
    envVars: getGitEnvVars(env),
  });
  await executeInSandbox(
    "git config user.email '68482183+kyleboas@users.noreply.github.com' && git config user.name 'Blob Bot'",
    env,
    { sandboxId, workspaceRoot, timeout: 30000, envVars: getGitEnvVars(env) },
  );
  await executeInSandbox(
    "git add -A && git reset HEAD -- .blob/memory/context.md .blob/memory/journal.md 2>/dev/null || true",
    env,
    { sandboxId, workspaceRoot, timeout: 30000, envVars: getGitEnvVars(env) },
  );

  const diffResult = await executeInSandbox("git diff --cached --no-ext-diff", env, {
    sandboxId,
    workspaceRoot,
    timeout: 30000,
    envVars: getGitEnvVars(env),
  });
  const scan = scanDiffForSecrets(diffResult.stdout);
  if (scan.blocked) {
    return { status: "skipped", reason: `secret-like content detected: ${scan.matches[0] ?? "blocked diff"}`, verificationCommand };
  }
  if (!diffResult.stdout.trim()) {
    return { status: "skipped", reason: "only ignored files changed", verificationCommand };
  }

  await executeInSandbox(
    `git commit -m ${shellQuote(`blob: ${task.slice(0, 60)}`)}`,
    env,
    { sandboxId, workspaceRoot, timeout: 30000, envVars: getGitEnvVars(env) },
  );
  const commitHash = (
    await executeInSandbox("git rev-parse HEAD", env, {
      sandboxId,
      workspaceRoot,
      timeout: 30000,
      envVars: getGitEnvVars(env),
    })
  ).stdout.trim();

  await executeInSandbox(
    `git push -u origin ${shellQuote(branch)}`,
    env,
    { sandboxId, workspaceRoot, timeout: 120000, envVars: getGitEnvVars(env) },
  );

  const [owner, repoName] = repo.split("/", 2);
  if (!owner || !repoName) {
    return { status: "skipped", reason: "invalid GitHub repo slug", verificationCommand };
  }

  const api = new GitHubApi(env.GITHUB_TOKEN, fetch, env);
  const existing = await api.findOpenPullRequestByHead({ owner, repo: repoName, head: `${owner}:${branch}` });
  if (existing) {
    return { status: "opened", url: existing.html_url, number: existing.number, branch, verificationCommand };
  }

  const pr = await api.createPullRequest({
    owner,
    repo: repoName,
    title: `blob: ${task.slice(0, 72)}`,
    body: buildPullRequestBody({ repo, task, jobId, summary: diagnosisSummary, verificationCommand }),
    head: branch,
    base: baseBranch,
    idempotencyKey: buildPrIdempotencyKey(branch, commitHash),
  });

  return { status: "opened", url: pr.html_url, number: pr.number, branch, verificationCommand };
}
