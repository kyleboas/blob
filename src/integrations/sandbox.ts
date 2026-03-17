import type { Env } from "../core/types";

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SandboxSession {
  lastUsedAt: number;
}

interface ToolOptions {
  sandboxId?: string;
  workspaceRoot?: string;
}

interface SandboxFileOptions {
  sandboxId?: string;
  encoding?: string;
}

interface GitCheckoutOptions {
  sessionId?: string;
  branch?: string;
  targetDir?: string;
  depth?: number;
  cwd?: string;
  envVars?: Record<string, string>;
}

const SANDBOX_STARTUP_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const SANDBOX_STARTUP_RETRYABLE_MESSAGES = [
  "container is not running",
  "container startup failed",
  "createSession",
  "there is no container instance that can be provided",
];
const WORKSPACE_STATE_DIR = "/workspace/blob_state";
const DEFAULT_SANDBOX_IO_TIMEOUT_MS = 60000;

const sessions = new Map<string, SandboxSession>();
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHttpStatus(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const statusMatch = message.match(/status:\s*(\d+)/i);
  return statusMatch ? Number.parseInt(statusMatch[1], 10) : undefined;
}

function isRetryableSandboxStartupError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return SANDBOX_STARTUP_RETRYABLE_MESSAGES.some((fragment) => message.includes(fragment));
}

function estimateBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function getSandboxIoTimeoutMs(env: Partial<Env>): number {
  const configured = Number.parseInt(env.SANDBOX_IO_TIMEOUT_MS ?? env.BASH_TIMEOUT_MS ?? `${DEFAULT_SANDBOX_IO_TIMEOUT_MS}`, 10);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SANDBOX_IO_TIMEOUT_MS;
  }
  return Math.min(configured, 120000);
}

function normalizeToolPath(path: string, workspaceRoot: string): string {
  if (!path) {
    throw new Error(`Path not allowed: ${path}`);
  }

  const workspaceAllowed = workspaceRoot === "/workspace" || workspaceRoot.startsWith("/workspace/");
  if (!workspaceAllowed || workspaceRoot.includes("..")) {
    throw new Error(`Workspace root not allowed: ${workspaceRoot}`);
  }

  const normalizedRoot = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;

  let normalized = path;

  // Strip the workspace prefix if the model used an absolute path
  if (normalized.startsWith(normalizedRoot)) {
    normalized = normalized.slice(normalizedRoot.length);
  }

  // Strip leading "./" for convenience
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Path not allowed: ${path}`);
  }

  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function withSandboxRetry<T>(opts: {
  env: Env;
  phase: "start" | "exec" | "writeFile" | "readFile";
  attempts?: number;
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

      if (!(attempt < attempts && retryable)) {
        throw err;
      }

      await delay(attempt * 500);
    }
  }

  throw lastError;
}

async function ensureSandboxStarted(env: Env): Promise<void> {
  if (typeof env.SANDBOX.start !== "function") {
    throw new Error("Sandbox service binding is missing start() implementation.");
  }

  await withSandboxRetry({
    env,
    phase: "start",
    attempts: 3,
    operation: () => env.SANDBOX.start!(),
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sandbox timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function touchSandboxSession(sandboxId: string): void {
  const existing = sessions.get(sandboxId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return;
  }
  sessions.set(sandboxId, { lastUsedAt: Date.now() });
}

export async function ensureSandboxSession(
  sandboxId: string,
  env: Env,
  opts: { cwd?: string; envVars?: Record<string, string> } = {},
): Promise<void> {
  await ensureSandboxStarted(env);
  touchSandboxSession(sandboxId);
  if (typeof env.SANDBOX.ensureSession === "function") {
    await withTimeout(
      env.SANDBOX.ensureSession(sandboxId, {
        cwd: opts.cwd,
        env: opts.envVars,
      }),
      getSandboxIoTimeoutMs(env),
    );
  }
}

export async function teardownIdleSandboxes(env: Env, now = Date.now()): Promise<string[]> {
  const idleMs = Number.parseInt(env.SANDBOX_IDLE_TIMEOUT_MS ?? "3600000", 10);
  const removed: string[] = [];
  const timeoutMs = getSandboxIoTimeoutMs(env);

  for (const [sandboxId, session] of sessions.entries()) {
    if (now - session.lastUsedAt >= idleMs) {
      sessions.delete(sandboxId);
      removed.push(sandboxId);
      if (typeof env.SANDBOX.deleteSession === "function") {
        await withTimeout(env.SANDBOX.deleteSession(sandboxId), timeoutMs).catch(() => {});
      }
    }
  }

  return removed;
}

export async function cleanupSandboxForJob(
  sandboxId: string,
  status: "completed" | "failed",
  env: Env,
): Promise<void> {
  const keepOnFailure = (env.SANDBOX_KEEP_ON_FAILURE ?? "true").toLowerCase() === "true";
  if (status === "failed" && keepOnFailure) {
    return;
  }

  if (sessions.has(sandboxId)) {
    sessions.delete(sandboxId);
  }

  if (typeof env.SANDBOX.deleteSession === "function") {
    await withTimeout(env.SANDBOX.deleteSession(sandboxId), getSandboxIoTimeoutMs(env)).catch(() => {});
  }
}

export async function executeInSandbox(
  command: string,
  env: Env,
  opts: { timeout?: number; sandboxId?: string; workspaceRoot?: string; cwd?: string; envVars?: Record<string, string> } = {},
): Promise<SandboxResult> {
  // Security boundary: Cloudflare Sandbox (Firecracker microVM) provides execution isolation. No application-level command filtering.

  if (opts.sandboxId) {
    touchSandboxSession(opts.sandboxId);
  } else {
    await ensureSandboxStarted(env);
  }

  const timeout = opts.timeout ?? Number.parseInt(env.BASH_TIMEOUT_MS ?? "120000", 10);
  const maxOutputBytes = Number.parseInt(env.BASH_MAX_OUTPUT_BYTES ?? "1000000", 10);
  const cwd = opts.cwd?.trim() ? opts.cwd : (opts.workspaceRoot ? resolveWorkspaceRoot(opts.workspaceRoot) : undefined);
  const result = await withTimeout(
    env.SANDBOX.exec(command.trim(), {
      sessionId: opts.sandboxId,
      timeout,
      cwd,
      env: opts.envVars,
    }),
    timeout,
  );
  if (estimateBytes(result.stdout) > maxOutputBytes) {
    result.stdout = result.stdout.slice(0, maxOutputBytes) + "\n[output truncated]";
  }
  if (estimateBytes(result.stderr) > maxOutputBytes) {
    result.stderr = result.stderr.slice(0, maxOutputBytes) + "\n[output truncated]";
  }
  return result;
}

export async function probeSandbox(env: Env): Promise<boolean> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await executeInSandbox("true", env, {
        cwd: "/workspace",
        timeout: 5000,
      });
      return result.exitCode === 0;
    } catch {
      if (attempt === maxAttempts) {
        return false;
      }
      await delay(250 * attempt);
    }
  }
  return false;
}

export async function readSandboxFile(path: string, env: Env, opts: SandboxFileOptions = {}): Promise<string> {
  if (opts.sandboxId) touchSandboxSession(opts.sandboxId);
  return withTimeout(
    env.SANDBOX.readFile(path, { sessionId: opts.sandboxId, encoding: opts.encoding }),
    getSandboxIoTimeoutMs(env),
  );
}

export async function writeSandboxFile(path: string, content: string, env: Env, opts: SandboxFileOptions = {}): Promise<void> {
  if (opts.sandboxId) touchSandboxSession(opts.sandboxId);
  await withTimeout(
    env.SANDBOX.writeFile(path, content, { sessionId: opts.sandboxId, encoding: opts.encoding }),
    getSandboxIoTimeoutMs(env),
  );
}

export async function fileExists(path: string, env: Env, opts: SandboxFileOptions = {}): Promise<boolean> {
  if (opts.sandboxId) touchSandboxSession(opts.sandboxId);
  const timeoutMs = getSandboxIoTimeoutMs(env);
  if (typeof env.SANDBOX.exists === "function") {
    const result = await withTimeout(env.SANDBOX.exists(path, { sessionId: opts.sandboxId }), timeoutMs);
    return result.exists;
  }
  return withTimeout(
    env.SANDBOX.readFile(path, { sessionId: opts.sandboxId, encoding: opts.encoding }),
    timeoutMs,
  ).then(() => true, () => false);
}

export async function deleteSandboxFile(path: string, env: Env, opts: { sandboxId?: string } = {}): Promise<void> {
  if (opts.sandboxId) {
    touchSandboxSession(opts.sandboxId);
  }
  const result = await withTimeout(
    env.SANDBOX.exec(`rm -f ${shellQuote(path)}`, {
      sessionId: opts.sandboxId,
      cwd: "/workspace",
    }),
    getSandboxIoTimeoutMs(env),
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to delete ${path}`);
  }
}

export async function gitCheckoutRepo(repoUrl: string, env: Env, opts: GitCheckoutOptions = {}): Promise<void> {
  if (opts.sessionId) touchSandboxSession(opts.sessionId);
  if (typeof env.SANDBOX.gitCheckout === "function") {
    const gitCheckoutOptions = {
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.branch ? { branch: opts.branch } : {}),
      ...(opts.targetDir ? { targetDir: opts.targetDir } : {}),
      ...(typeof opts.depth === "number" ? { depth: opts.depth } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.envVars ? { env: opts.envVars } : {}),
    };
    await withTimeout(
      env.SANDBOX.gitCheckout(repoUrl, gitCheckoutOptions),
      getSandboxIoTimeoutMs(env),
    );
    return;
  }

  const branchArg = opts.branch ? ` --branch ${shellQuote(opts.branch)}` : "";
  const depthArg = typeof opts.depth === "number" ? ` --depth=${opts.depth}` : "";
  const targetDirArg = opts.targetDir ? ` ${shellQuote(opts.targetDir)}` : "";
  const clone = await executeInSandbox(
    `mkdir -p /workspace && git clone${depthArg}${branchArg} ${shellQuote(repoUrl)}${targetDirArg}`,
    env,
    {
      sandboxId: opts.sessionId,
      cwd: opts.cwd ?? "/workspace",
      envVars: opts.envVars,
    },
  );
  if (clone.exitCode !== 0) {
    throw new Error(clone.stderr || clone.stdout || `git checkout failed for ${repoUrl}`);
  }
}

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot && workspaceRoot.trim() ? workspaceRoot : "/workspace/blob";
}

export async function readTool(path: string, env: Env, opts: ToolOptions = {}): Promise<string> {
  const workspaceRoot = resolveWorkspaceRoot(opts.workspaceRoot);
  const normalized = normalizeToolPath(path, workspaceRoot);
  if (opts.sandboxId) touchSandboxSession(opts.sandboxId);

  const content = await readSandboxFile(`${workspaceRoot}/${normalized}`, env, { sandboxId: opts.sandboxId });
  const maxBytes = Number.parseInt(env.TOOL_MAX_FILE_BYTES ?? "200000", 10);
  if (estimateBytes(content) > maxBytes) {
    throw new Error(`File exceeds max size: ${path}`);
  }
  return content;
}

export async function writeTool(path: string, content: string, env: Env, opts: ToolOptions = {}): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot(opts.workspaceRoot);
  const normalized = normalizeToolPath(path, workspaceRoot);
  const maxBytes = Number.parseInt(env.TOOL_MAX_FILE_BYTES ?? "200000", 10);
  if (estimateBytes(content) > maxBytes) {
    throw new Error(`Write content exceeds max size: ${path}`);
  }
  if (opts.sandboxId) touchSandboxSession(opts.sandboxId);

  const abs = `${workspaceRoot}/${normalized}`;
  const temp = `${abs}.tmp`;
  const timeoutMs = getSandboxIoTimeoutMs(env);
  await writeSandboxFile(temp, content, env, { sandboxId: opts.sandboxId });
  if (typeof env.SANDBOX.renameFile === "function") {
    await withTimeout(env.SANDBOX.renameFile(temp, abs, { sessionId: opts.sandboxId }), timeoutMs);
  } else {
    await withTimeout(
      env.SANDBOX.exec(`mv ${shellQuote(temp)} ${shellQuote(abs)}`, { sessionId: opts.sandboxId }),
      timeoutMs,
    );
  }
}

export async function editTool(
  path: string,
  oldText: string,
  newText: string,
  env: Env,
  opts: ToolOptions = {},
): Promise<void> {
  const current = await readTool(path, env, opts);
  if (!current.includes(oldText)) {
    throw new Error("oldText not found in file");
  }
  await writeTool(path, current.replace(oldText, newText), env, opts);
}

export async function appendWorkspaceState(
  kind: "log" | "context",
  line: string,
  env: Env,
  sandboxId?: string,
): Promise<void> {
  const fileName = `${WORKSPACE_STATE_DIR}/${kind}.jsonl`;
  if (sandboxId) touchSandboxSession(sandboxId);
  const current = await readSandboxFile(fileName, env, { sandboxId }).catch(() => "");
  await writeSandboxFile(fileName, `${current}${line.endsWith("\n") ? line : `${line}\n`}`, env, { sandboxId });
}

export async function readWorkspaceState(kind: "log" | "context", env: Env, sandboxId?: string): Promise<string> {
  const fileName = `${WORKSPACE_STATE_DIR}/${kind}.jsonl`;
  if (sandboxId) touchSandboxSession(sandboxId);
  return readSandboxFile(fileName, env, { sandboxId }).catch(() => "");
}

export function __resetSandboxSessionsForTests(): void {
  sessions.clear();
}

export const __sandboxTestUtils = { normalizeToolPath, resolveWorkspaceRoot };
