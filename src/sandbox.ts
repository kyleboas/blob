import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SANDBOX_STARTUP_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const SANDBOX_STARTUP_RETRYABLE_MESSAGES = [
  "container is not running",
  "container crashed while checking for ports",
  "consider calling start()",
  "container startup failed",
  "createSession",
  "checking for ports",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHttpStatus(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const statusMatch = message.match(/status:\s*(\d+)/i);
  if (!statusMatch) return undefined;
  return Number.parseInt(statusMatch[1], 10);
}

function isRetryableSandboxStartupError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return SANDBOX_STARTUP_RETRYABLE_MESSAGES.some((fragment) => message.includes(fragment));
}

function formatSandboxError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function createSandboxDiagnostic(
  phase: "start" | "exec" | "writeFile" | "readFile",
  attempt: number,
  err: unknown,
  command?: string,
  path?: string,
): string {
  const status = parseHttpStatus(err);
  const message = formatSandboxError(err);
  return JSON.stringify({
    phase,
    attempt,
    command,
    path,
    status,
    retryableStatus: status !== undefined ? SANDBOX_STARTUP_RETRYABLE_STATUS.has(status) : false,
    retryableMessage: isRetryableSandboxStartupError(err),
    message,
  });
}

async function withSandboxRetry<T>(opts: {
  env: Env;
  phase: "start" | "exec" | "writeFile" | "readFile";
  attempts?: number;
  command?: string;
  path?: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await opts.operation();
    } catch (err) {
      lastError = err;
      const status = parseHttpStatus(err);
      const retryable =
        isRetryableSandboxStartupError(err) ||
        (status !== undefined && SANDBOX_STARTUP_RETRYABLE_STATUS.has(status));

      const diagnostic = createSandboxDiagnostic(opts.phase, attempt, err, opts.command, opts.path);
      console.error(`sandbox_${opts.phase}_failure`, diagnostic);

      if (!(attempt < attempts && retryable)) {
        throw new Error(
          `Sandbox ${opts.phase} failed after ${attempt} attempt(s). Diagnostic: ${diagnostic}`,
        );
      }

      await delay(attempt * 500);
    }
  }

  throw lastError;
}

async function ensureSandboxStarted(env: Env, contextCommand?: string): Promise<void> {
  if (typeof env.SANDBOX.start !== "function") {
    throw new Error(
      "Sandbox service binding is missing start(); check blob-agent -> blob-sandbox service interface wiring.",
    );
  }

  await withSandboxRetry({
    env,
    phase: "start",
    attempts: 3,
    command: contextCommand,
    operation: () => env.SANDBOX.start!(),
  });
}

async function execWithRetry(env: Env, command: string, attempts = 3): Promise<SandboxResult> {
  await ensureSandboxStarted(env, command);
  return withSandboxRetry({
    env,
    phase: "exec",
    attempts,
    command,
    operation: () => env.SANDBOX.exec(command),
  });
}

async function writeFileWithRetry(env: Env, path: string, content: string, attempts = 3): Promise<void> {
  await ensureSandboxStarted(env, `writeFile:${path}`);
  await withSandboxRetry({
    env,
    phase: "writeFile",
    attempts,
    path,
    operation: () => env.SANDBOX.writeFile(path, content),
  });
}

async function readFileWithRetry(env: Env, path: string, attempts = 3): Promise<string> {
  await ensureSandboxStarted(env, `readFile:${path}`);
  return withSandboxRetry({
    env,
    phase: "readFile",
    attempts,
    path,
    operation: () => env.SANDBOX.readFile(path),
  });
}

// Validate command before execution
function validateCommand(command: string): { valid: boolean; error?: string } {
  const dangerous = [/rm\s+-rf\s+\//, /:\(\)\{\s*:\|:\s*\&\s*\}.*:\)/];

  for (const pattern of dangerous) {
    if (pattern.test(command)) {
      return { valid: false, error: `Dangerous command blocked: ${command}` };
    }
  }

  return { valid: true };
}

export async function executeInSandbox(
  command: string,
  env: Env,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<SandboxResult> {
  const validation = validateCommand(command);
  if (!validation.valid) throw new Error(validation.error);

  return execWithRetry(env, command);
}

// Start Codex device-code login flow
export async function startCodexLogin(env: Env): Promise<{ url: string; code?: string; instructions: string }> {
  const result = await execWithRetry(env, "codex login");

  const urlMatch = result.stdout.match(/https:\/\/[^\s]+/);
  const codeMatch = result.stdout.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8})\b/);

  return {
    url: urlMatch?.[0] || "https://platform.openai.com/login",
    code: codeMatch?.[1],
    instructions: result.stdout || "Run 'codex login' to authenticate",
  };
}

// Save Codex auth to persistent storage
export async function saveCodexAuth(env: Env): Promise<{ saved: boolean; message: string }> {
  const copy = await execWithRetry(
    env,
    "mkdir -p /workspace/.codex-auth && cp /root/.codex/auth.json /workspace/.codex-auth/auth.json",
  );

  if (copy.exitCode !== 0) {
    return {
      saved: false,
      message: copy.stderr || "Failed to save auth",
    };
  }

  return { saved: true, message: "Auth saved" };
}

export async function readSandboxFile(path: string, env: Env): Promise<string> {
  return readFileWithRetry(env, path);
}

// Run Codex with a prompt

export async function ensureRepoReady(repo: string, env: Env): Promise<SandboxResult> {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._\/-]/g, "");
  if (!safeRepo.includes("/")) {
    throw new Error(`Repository must be in owner/repo format. Received: ${repo}`);
  }

  const command = [
    "set -e",
    "mkdir -p /workspace",
    "cd /workspace",
    `if [ ! -d ${safeRepo}/.git ]; then git clone https://github.com/${safeRepo}.git ${safeRepo}; fi`,
    `cd ${safeRepo}`,
    "git fetch --all --prune",
    "git checkout -f main || git checkout -f master || true",
    "git pull --ff-only || true",
    "git config user.name 'blob-agent'",
    "git config user.email 'blob-agent@local'",
  ].join(" && ");

  return execWithRetry(env, command);
}


export interface RepoFinalizeResult {
  changed: boolean;
  committed: boolean;
  pushed: boolean;
  branch?: string;
  commit?: string;
  message: string;
}

export async function finalizeRepoChanges(
  repo: string,
  env: Env,
  opts: { commitMessage?: string } = {},
): Promise<RepoFinalizeResult> {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._\/-]/g, "");
  if (!safeRepo.includes("/")) {
    throw new Error(`Repository must be in owner/repo format. Received: ${repo}`);
  }

  const cleanMsg = (opts.commitMessage ?? "blob: autonomous update")
    .replace(/[^a-zA-Z0-9 .,_:-]/g, " ")
    .trim()
    .slice(0, 120) || "blob: autonomous update";

  const status = await execWithRetry(
    env,
    `cd /workspace/${safeRepo} && git status --porcelain`,
  );

  if (!status.stdout.trim()) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      message: "No file changes produced by autonomous run",
    };
  }

  const branchName = `blob/auto-${Date.now()}`;
  const commitStep = await execWithRetry(
    env,
    [
      `cd /workspace/${safeRepo}`,
      `git checkout -B ${branchName}`,
      "git add -A",
      `git commit -m "${cleanMsg}"`,
      "git rev-parse HEAD",
    ].join(" && "),
  );

  if (commitStep.exitCode !== 0) {
    return {
      changed: true,
      committed: false,
      pushed: false,
      branch: branchName,
      message: commitStep.stderr || commitStep.stdout || "Commit failed",
    };
  }

  const commitSha = commitStep.stdout.trim().split("\n").pop() || "";

  if (!env.GITHUB_TOKEN) {
    return {
      changed: true,
      committed: true,
      pushed: false,
      branch: branchName,
      commit: commitSha,
      message: "Committed locally. Skipped push because GITHUB_TOKEN is not configured",
    };
  }

  const push = await execWithRetry(
    env,
    [
      `cd /workspace/${safeRepo}`,
      "export GIT_ASKPASS=/usr/local/bin/blob-git-askpass",
      `git push -u origin ${branchName}`,
    ].join(" && "),
  );

  if (push.exitCode !== 0) {
    return {
      changed: true,
      committed: true,
      pushed: false,
      branch: branchName,
      commit: commitSha,
      message: push.stderr || push.stdout || "Push failed",
    };
  }

  return {
    changed: true,
    committed: true,
    pushed: true,
    branch: branchName,
    commit: commitSha,
    message: `Pushed ${branchName}`,
  };
}

export async function runCodex(
  prompt: string,
  env: Env,
  opts: { timeout?: number } = {},
): Promise<SandboxResult> {
  await writeFileWithRetry(env, "/tmp/prompt.txt", prompt);
  return execWithRetry(env, "codex -f /tmp/prompt.txt");
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  try {
    const result = await execWithRetry(env, "echo 'health check'");
    if (result.exitCode === 0) return { ready: true };
    return { ready: false, message: `Sandbox returned exit code ${result.exitCode}: ${result.stderr}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${formatSandboxError(err)}` };
  }
}
