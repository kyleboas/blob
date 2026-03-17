import type { Env } from "../core/types";
import { executeInSandbox, gitCheckoutRepo } from "../integrations/sandbox";
import { GitHubApi, type GitHubIssue, type GitHubWorkflowRun } from "../integrations/github";

export type CloudflareLogSignal = {
  worker: string;
  message: string;
  timestamp?: string;
};

export type RepoDiagnosis = {
  repo: string;
  repoDir: string;
  generatedAt: string;
  verificationCommand?: string;
  verificationStatus: "passed" | "failed" | "missing" | "error";
  verificationOutput?: string;
  latestCommit?: string;
  todoMatches: string[];
  openIssues: Array<Pick<GitHubIssue, "number" | "title" | "html_url" | "updated_at">>;
  failedWorkflowRuns: Array<Pick<GitHubWorkflowRun, "name" | "html_url" | "head_branch" | "created_at">>;
  cloudflareSignals: CloudflareLogSignal[];
  summary: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function summarizeText(text: string, maxChars = 1200): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

export function repoDirFromSlug(repo: string): string {
  return repo.includes("/") ? repo.split("/").pop()! : repo;
}

function shouldFetchExternalSignals(verificationStatus: RepoDiagnosis["verificationStatus"]): boolean {
  return verificationStatus === "passed" || verificationStatus === "missing";
}

export function getGitEnvVars(env: Env): Record<string, string> | undefined {
  if (!env.GITHUB_TOKEN) return undefined;
  return {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function ensureRepoWorkspaceReady(
  env: Env,
  repo: string,
  sandboxId: string,
  timeout = 180000,
): Promise<{ repoDir: string; workspaceRoot: string }> {
  const repoDir = repoDirFromSlug(repo);
  const workspaceRoot = `/workspace/${repoDir}`;
  const gitEnvVars = getGitEnvVars(env);

  const hasGit = await executeInSandbox(`test -d ${shellQuote(`${workspaceRoot}/.git`)}`, env, {
    sandboxId,
    timeout: 30000,
    envVars: gitEnvVars,
  });

  if (hasGit.exitCode !== 0) {
    if (!repo.includes("/")) {
      const mkdir = await executeInSandbox(`mkdir -p ${shellQuote(workspaceRoot)}`, env, {
        sandboxId,
        timeout: 30000,
        envVars: gitEnvVars,
      });
      if (mkdir.exitCode !== 0) {
        throw new Error(`repo bootstrap failed (${repoDir}): ${summarizeText(mkdir.stderr || mkdir.stdout || "mkdir failed", 400)}`);
      }
      return { repoDir, workspaceRoot };
    }

    const repoUrl = `https://github.com/${repo}.git`;
    try {
      await gitCheckoutRepo(repoUrl, env, {
        sessionId: sandboxId,
        targetDir: workspaceRoot,
        depth: 1,
        envVars: gitEnvVars,
      });
    } catch (err) {
      throw new Error(`repo bootstrap failed (${repoDir}): ${summarizeText(String(err), 400)}`);
    }
  }

  const refresh = await executeInSandbox(
    `set -eu
git fetch --depth=1 --prune origin
default_branch="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')"
if [ -n "$default_branch" ] && git show-ref --verify --quiet "refs/remotes/origin/$default_branch"; then
  git checkout -B "$default_branch" "origin/$default_branch"
fi`,
    env,
    { sandboxId, workspaceRoot, timeout, envVars: gitEnvVars },
  );
  if (refresh.exitCode !== 0) {
    throw new Error(`repo bootstrap failed (${repoDir}): ${summarizeText(refresh.stderr || refresh.stdout || "refresh failed", 400)}`);
  }

  return { repoDir, workspaceRoot };
}

export async function detectVerificationCommand(
  env: Env,
  repo: string,
  sandboxId: string,
): Promise<string | undefined> {
  const configured = env.VERIFY_COMMAND?.trim();
  if (configured) return configured;

  const { workspaceRoot } = await ensureRepoWorkspaceReady(env, repo, sandboxId, 180000);
  const result = await executeInSandbox(
    `set +e
# blob-detect-verify-command
python3 - <<'PY'
import json
import os
import re

def run_cmd(runner: str, script: str) -> str:
    return f"{runner} {script}" if runner == "yarn" else f"{runner} run {script}"

def detect_js() -> str:
    if not os.path.exists("package.json"):
        return ""
    try:
        with open("package.json", "r", encoding="utf-8") as fh:
            pkg = json.load(fh)
    except Exception:
        return ""
    scripts = pkg.get("scripts") or {}
    package_manager = str(pkg.get("packageManager") or "")
    if package_manager.startswith("pnpm@") or os.path.exists("pnpm-lock.yaml"):
        runner = "pnpm"
    elif package_manager.startswith("yarn@") or os.path.exists("yarn.lock"):
        runner = "yarn"
    elif package_manager.startswith("bun@") or os.path.exists("bun.lock") or os.path.exists("bun.lockb"):
        runner = "bun"
    else:
        runner = "npm"
    test_script = str(scripts.get("test") or "")
    no_test = bool(re.search(r"no test specified", test_script, re.I))
    candidates = []
    if isinstance(scripts.get("verify"), str):
        candidates.append(run_cmd(runner, "verify"))
    if isinstance(scripts.get("test:ci"), str):
        candidates.append(run_cmd(runner, "test:ci"))
    if isinstance(scripts.get("ci:test"), str):
        candidates.append(run_cmd(runner, "ci:test"))
    if isinstance(scripts.get("typecheck"), str) and isinstance(scripts.get("test"), str) and not no_test:
        candidates.append(f"{run_cmd(runner, 'typecheck')} && {run_cmd(runner, 'test')}")
    if isinstance(scripts.get("check"), str) and isinstance(scripts.get("test"), str) and not no_test:
        candidates.append(f"{run_cmd(runner, 'check')} && {run_cmd(runner, 'test')}")
    if isinstance(scripts.get("test"), str) and not no_test:
        candidates.append(run_cmd(runner, "test"))
    if isinstance(scripts.get("typecheck"), str):
        candidates.append(run_cmd(runner, "typecheck"))
    return candidates[0] if candidates else ""

command = detect_js()
if not command and (os.path.exists("pyproject.toml") or os.path.exists("pytest.ini") or os.path.exists("tox.ini") or os.path.isdir("tests")):
    command = "pytest -q"
if not command and os.path.exists("Cargo.toml"):
    command = "cargo test"
if not command and os.path.exists("go.mod"):
    command = "go test ./..."
if not command and (os.path.exists("deno.json") or os.path.exists("deno.jsonc")):
    command = "deno test"
if not command and os.path.exists("Makefile"):
    try:
        with open("Makefile", "r", encoding="utf-8", errors="ignore") as fh:
            if re.search(r"(?m)^test\\s*:", fh.read()):
                command = "make test"
    except Exception:
        command = ""
print(command)
PY`,
    env,
    {
      sandboxId,
      workspaceRoot,
      timeout: 30000,
    },
  );

  const command = result.stdout.trim();
  return command ? command : undefined;
}

async function fetchGitHubSignals(env: Env, repo: string): Promise<{
  openIssues: RepoDiagnosis["openIssues"];
  failedWorkflowRuns: RepoDiagnosis["failedWorkflowRuns"];
}> {
  if (!env.GITHUB_TOKEN || !repo.includes("/")) {
    return { openIssues: [], failedWorkflowRuns: [] };
  }
  const [owner, repoName] = repo.split("/", 2);
  if (!owner || !repoName) {
    return { openIssues: [], failedWorkflowRuns: [] };
  }

  try {
    const api = new GitHubApi(env.GITHUB_TOKEN, fetch, env);
    const [issues, runs] = await Promise.all([
      api.listOpenIssues({ owner, repo: repoName, perPage: 5 }),
      api.listFailedWorkflowRuns({ owner, repo: repoName, perPage: 5 }),
    ]);
    return {
      openIssues: issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        html_url: issue.html_url,
        updated_at: issue.updated_at,
      })),
      failedWorkflowRuns: runs.map((run) => ({
        name: run.name,
        html_url: run.html_url,
        head_branch: run.head_branch,
        created_at: run.created_at,
      })),
    };
  } catch (_err) {
    return { openIssues: [], failedWorkflowRuns: [] };
  }
}

export async function diagnoseRepo(
  env: Env,
  repo: string,
  sandboxId: string,
): Promise<RepoDiagnosis> {
  const { repoDir, workspaceRoot } = await ensureRepoWorkspaceReady(env, repo, sandboxId, 180000);

  const [verificationCommand, latestCommitResult, todoResult] = await Promise.all([
    detectVerificationCommand(env, repo, sandboxId),
    executeInSandbox("git log -1 --pretty=format:'%h %s'", env, {
      sandboxId,
      workspaceRoot,
      timeout: 30000,
    }),
    executeInSandbox(
      "set +e; rg -n --hidden --glob '!.git' --glob '!node_modules' --glob '!dist' --glob '!coverage' 'TODO|FIXME|XXX|HACK' . | head -n 20",
      env,
      {
        sandboxId,
        workspaceRoot,
        timeout: 30000,
      },
    ),
  ]);

  let verificationStatus: RepoDiagnosis["verificationStatus"] = "missing";
  let verificationOutput = "";

  if (verificationCommand) {
    try {
      const verification = await executeInSandbox(verificationCommand, env, {
        sandboxId,
        workspaceRoot,
        timeout: 180000,
      });
      verificationOutput = summarizeText([verification.stdout, verification.stderr].filter(Boolean).join("\n"), 2000);
      verificationStatus = verification.exitCode === 0 ? "passed" : "failed";
    } catch (err) {
      verificationStatus = "error";
      verificationOutput = summarizeText(err instanceof Error ? err.message : String(err), 2000);
    }
  }

  const todoMatches = todoResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);

  const [githubSignals, cloudflareSignals] = shouldFetchExternalSignals(verificationStatus)
    ? await Promise.all([fetchGitHubSignals(env, repo), Promise.resolve([] as CloudflareLogSignal[])])
    : [{ openIssues: [], failedWorkflowRuns: [] }, []];

  const latestCommit = latestCommitResult.stdout.trim() || undefined;
  const summaryParts = [
    `Verification ${verificationStatus}${verificationCommand ? ` via ${verificationCommand}` : ""}`,
    latestCommit ? `latest commit ${latestCommit}` : "",
    todoMatches.length > 0 ? `${todoMatches.length} TODO/FIXME hits` : "no TODO/FIXME hits found",
    githubSignals.openIssues.length > 0 ? `${githubSignals.openIssues.length} open GitHub issues` : "",
    githubSignals.failedWorkflowRuns.length > 0 ? `${githubSignals.failedWorkflowRuns.length} failed workflow runs` : "",
    cloudflareSignals.length > 0 ? `${cloudflareSignals.length} Cloudflare log signals` : "",
    verificationOutput ? `output: ${verificationOutput}` : "",
  ].filter(Boolean);

  return {
    repo,
    repoDir,
    generatedAt: new Date().toISOString(),
    verificationCommand,
    verificationStatus,
    verificationOutput: verificationOutput || undefined,
    latestCommit,
    todoMatches,
    openIssues: githubSignals.openIssues,
    failedWorkflowRuns: githubSignals.failedWorkflowRuns,
    cloudflareSignals,
    summary: summaryParts.join("; "),
  };
}
