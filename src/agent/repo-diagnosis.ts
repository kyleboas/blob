import type { Env } from "../core/types";
import { executeInSandbox } from "../integrations/sandbox";
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

function getCloudflareAccountId(env: Env): string | undefined {
  return env.CLOUDFLARE_ACCOUNT_ID ?? env.ACCOUNT_ID;
}

function getCloudflareWorkers(env: Env): string[] {
  const configured = (env.CLOUDFLARE_DIAG_WORKERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return env.WORKER_NAME ? [env.WORKER_NAME] : [];
}

export function buildRepoBootstrapScript(repoDir: string, repo: string): string {
  const workspaceRoot = `/workspace/${repoDir}`;
  const hasRepoSlug = repo.includes("/");
  const cloneUrl = hasRepoSlug ? `https://github.com/${repo}.git` : "";
  const cloneStep = hasRepoSlug
    ? `    git clone --depth=1 ${shellQuote(cloneUrl)} ${shellQuote(workspaceRoot)}\n`
    : `    mkdir -p ${shellQuote(workspaceRoot)}\n`;

  return `set -eu
if [ -n "${"${GITHUB_TOKEN:-}"}" ]; then
  cat > /usr/local/bin/blob-git-askpass << 'EOF'
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) echo "$GITHUB_TOKEN" ;;
esac
EOF
  chmod +x /usr/local/bin/blob-git-askpass
fi
mkdir -p /workspace
if [ -d ${shellQuote(`${workspaceRoot}/.git`)} ]; then
  cd ${shellQuote(workspaceRoot)}
  git fetch --depth=1 --prune origin
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    git reset --hard origin/main
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    git reset --hard origin/master
  else
    git pull --ff-only
  fi
else
${cloneStep}  if [ -d ${shellQuote(`${workspaceRoot}/.git`)} ]; then
    cd ${shellQuote(workspaceRoot)}
    if git show-ref --verify --quiet refs/remotes/origin/main; then
      git checkout -B main origin/main
    elif git show-ref --verify --quiet refs/remotes/origin/master; then
      git checkout -B master origin/master
    fi
  fi
fi`;
}

export async function detectVerificationCommand(
  env: Env,
  repo: string,
  sandboxId: string,
): Promise<string | undefined> {
  const configured = env.VERIFY_COMMAND?.trim();
  if (configured) return configured;

  const repoDir = repoDirFromSlug(repo);
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
      workspaceRoot: `/workspace/${repoDir}`,
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

async function fetchCloudflareSignals(env: Env): Promise<CloudflareLogSignal[]> {
  const accountId = getCloudflareAccountId(env);
  if (!env.CLOUDFLARE_API_TOKEN || !accountId) return [];

  const workers = getCloudflareWorkers(env);
  if (workers.length === 0) return [];

  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const signals: CloudflareLogSignal[] = [];

  for (const worker of workers.slice(0, 3)) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/telemetry/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            view: "events",
            limit: 5,
            parameters: {
              datasets: ["workers_trace_events"],
              filters: [
                { key: "ScriptName", operation: "eq", type: "string", value: worker },
                { key: "Timestamp", operation: "gte", type: "datetime", value: since },
              ],
            },
          }),
        },
      );
      if (!response.ok) continue;
      const payload = await response.json() as {
        result?: { events?: Array<Record<string, unknown>> };
        events?: Array<Record<string, unknown>>;
      };
      const events = payload.result?.events ?? payload.events ?? [];
      for (const event of events) {
        const metadata = typeof event === "object" && event !== null
          ? (event as Record<string, unknown>)["$metadata"]
          : undefined;
        const rawMessage =
          event.Exceptions ||
          event.Logs ||
          event.Message ||
          event.Event ||
          (typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).message : undefined);
        const message = typeof rawMessage === "string" ? summarizeText(rawMessage, 240) : "";
        if (!message) continue;
        signals.push({
          worker,
          message,
          timestamp: typeof event.Timestamp === "string" ? event.Timestamp : undefined,
        });
      }
    } catch (_err) {
      void _err;
    }
  }

  return signals.slice(0, 5);
}

export async function diagnoseRepo(
  env: Env,
  repo: string,
  sandboxId: string,
): Promise<RepoDiagnosis> {
  const repoDir = repoDirFromSlug(repo);
  const workspaceRoot = `/workspace/${repoDir}`;
  const envVars = env.GITHUB_TOKEN
    ? {
        GITHUB_TOKEN: env.GITHUB_TOKEN,
        GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
        GIT_TERMINAL_PROMPT: "0",
      }
    : undefined;

  const bootstrap = await executeInSandbox(buildRepoBootstrapScript(repoDir, repo), env, {
    sandboxId,
    timeout: 180000,
    envVars,
  });
  if (bootstrap.exitCode !== 0) {
    const message = summarizeText(bootstrap.stderr || bootstrap.stdout || "unknown bootstrap error", 400);
    throw new Error(`repo bootstrap failed (${repoDir}): ${message}`);
  }

  const [verificationCommand, latestCommitResult, todoResult, githubSignals, cloudflareSignals] = await Promise.all([
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
    fetchGitHubSignals(env, repo),
    fetchCloudflareSignals(env),
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
