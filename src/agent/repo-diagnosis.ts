import type { Env } from "../core/types";
import { executeInSandbox } from "../integrations/sandbox";

export type RepoDiagnosis = {
  repo: string;
  repoDir: string;
  generatedAt: string;
  verificationCommand?: string;
  verificationStatus: "passed" | "failed" | "missing" | "error";
  verificationOutput?: string;
  latestCommit?: string;
  todoMatches: string[];
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

  const latestCommit = latestCommitResult.stdout.trim() || undefined;
  const summaryParts = [
    `Verification ${verificationStatus}${verificationCommand ? ` via ${verificationCommand}` : ""}`,
    latestCommit ? `latest commit ${latestCommit}` : "",
    todoMatches.length > 0 ? `${todoMatches.length} TODO/FIXME hits` : "no TODO/FIXME hits found",
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
    summary: summaryParts.join("; "),
  };
}
