import type { Env } from "../core/types";

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SandboxSession {
  lastUsedAt: number;
}

const SANDBOX_STARTUP_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const SANDBOX_STARTUP_RETRYABLE_MESSAGES = ["container is not running", "container startup failed", "createSession"];
const SANDBOX_STATE_PREFIX = "sandbox-state/";
const WORKSPACE_STATE_DIR = "/workspace/blob_state";

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

const WORKSPACE_PREFIX = "/workspace/blob/";

function normalizeToolPath(path: string): string {
  if (!path) {
    throw new Error(`Path not allowed: ${path}`);
  }

  let normalized = path;

  // Strip the workspace prefix if the model used an absolute path
  if (normalized.startsWith(WORKSPACE_PREFIX)) {
    normalized = normalized.slice(WORKSPACE_PREFIX.length);
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

function allowedCommand(command: string): boolean {
  const blocked = [/rm\s+-rf\s+\//, /:\(\)\{\s*:\|:\s*&\s*\}.*:\)/, /shutdown/, /reboot/];
  return !blocked.some((pattern) => pattern.test(command));
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

async function persistWorkspaceState(sandboxId: string, env: Env): Promise<void> {
  if (!env.REPO_STORE) return;
  const [log, context] = await Promise.all([
    env.SANDBOX.readFile(`${WORKSPACE_STATE_DIR}/log.jsonl`).catch(() => ""),
    env.SANDBOX.readFile(`${WORKSPACE_STATE_DIR}/context.jsonl`).catch(() => ""),
  ]);

  await env.REPO_STORE.put(`${SANDBOX_STATE_PREFIX}${sandboxId}.json`, JSON.stringify({ log, context }));
}

async function restoreWorkspaceState(sandboxId: string, env: Env): Promise<void> {
  if (!env.REPO_STORE) return;
  const saved = await env.REPO_STORE.get(`${SANDBOX_STATE_PREFIX}${sandboxId}.json`);
  if (!saved) return;
  const payload = await saved.json<{ log?: string; context?: string }>();
  if (payload.log) {
    await env.SANDBOX.writeFile(`${WORKSPACE_STATE_DIR}/log.jsonl`, payload.log);
  }
  if (payload.context) {
    await env.SANDBOX.writeFile(`${WORKSPACE_STATE_DIR}/context.jsonl`, payload.context);
  }
}

export async function ensureSandboxSession(sandboxId: string, env: Env): Promise<void> {
  await ensureSandboxStarted(env);

  if (!sessions.has(sandboxId)) {
    await restoreWorkspaceState(sandboxId, env);
    sessions.set(sandboxId, { lastUsedAt: Date.now() });
  } else {
    sessions.get(sandboxId)!.lastUsedAt = Date.now();
  }
}

export async function teardownIdleSandboxes(env: Env, now = Date.now()): Promise<string[]> {
  const idleMs = Number.parseInt(env.SANDBOX_IDLE_TIMEOUT_MS ?? "3600000", 10);
  const removed: string[] = [];

  for (const [sandboxId, session] of sessions.entries()) {
    if (now - session.lastUsedAt >= idleMs) {
      await persistWorkspaceState(sandboxId, env);
      sessions.delete(sandboxId);
      removed.push(sandboxId);
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
    await persistWorkspaceState(sandboxId, env);
    sessions.delete(sandboxId);
  }
}

export async function executeInSandbox(
  command: string,
  env: Env,
  opts: { timeout?: number; sandboxId?: string } = {},
): Promise<SandboxResult> {
  if (!allowedCommand(command)) {
    throw new Error(`Dangerous command blocked: ${command}`);
  }

  if (opts.sandboxId) {
    await ensureSandboxSession(opts.sandboxId, env);
  } else {
    await ensureSandboxStarted(env);
  }

  const timeout = opts.timeout ?? Number.parseInt(env.BASH_TIMEOUT_MS ?? "120000", 10);
  const maxOutputBytes = Number.parseInt(env.BASH_MAX_OUTPUT_BYTES ?? "1000000", 10);
  const result = await withTimeout(env.SANDBOX.exec(command), timeout);
  if (estimateBytes(result.stdout) > maxOutputBytes) {
    result.stdout = result.stdout.slice(0, maxOutputBytes) + "\n[output truncated]";
  }
  if (estimateBytes(result.stderr) > maxOutputBytes) {
    result.stderr = result.stderr.slice(0, maxOutputBytes) + "\n[output truncated]";
  }
  return result;
}

export async function readTool(path: string, env: Env, sandboxId?: string): Promise<string> {
  const normalized = normalizeToolPath(path);
  if (sandboxId) await ensureSandboxSession(sandboxId, env);

  const content = await env.SANDBOX.readFile(`/workspace/blob/${normalized}`);
  const maxBytes = Number.parseInt(env.TOOL_MAX_FILE_BYTES ?? "200000", 10);
  if (estimateBytes(content) > maxBytes) {
    throw new Error(`File exceeds max size: ${path}`);
  }
  return content;
}

export async function writeTool(path: string, content: string, env: Env, sandboxId?: string): Promise<void> {
  const normalized = normalizeToolPath(path);
  const maxBytes = Number.parseInt(env.TOOL_MAX_FILE_BYTES ?? "200000", 10);
  if (estimateBytes(content) > maxBytes) {
    throw new Error(`Write content exceeds max size: ${path}`);
  }
  if (sandboxId) await ensureSandboxSession(sandboxId, env);

  const abs = `/workspace/blob/${normalized}`;
  const temp = `${abs}.tmp`;
  await env.SANDBOX.writeFile(temp, content);
  await env.SANDBOX.exec(`mv ${temp} ${abs}`);
}

export async function editTool(
  path: string,
  oldText: string,
  newText: string,
  env: Env,
  sandboxId?: string,
): Promise<void> {
  const current = await readTool(path, env, sandboxId);
  if (!current.includes(oldText)) {
    throw new Error("oldText not found in file");
  }
  await writeTool(path, current.replace(oldText, newText), env, sandboxId);
}

export async function appendWorkspaceState(
  kind: "log" | "context",
  line: string,
  env: Env,
  sandboxId?: string,
): Promise<void> {
  const fileName = `${WORKSPACE_STATE_DIR}/${kind}.jsonl`;
  if (sandboxId) await ensureSandboxSession(sandboxId, env);
  const current = await env.SANDBOX.readFile(fileName).catch(() => "");
  await env.SANDBOX.writeFile(fileName, `${current}${line.endsWith("\n") ? line : `${line}\n`}`);
}

export async function readWorkspaceState(kind: "log" | "context", env: Env, sandboxId?: string): Promise<string> {
  const fileName = `${WORKSPACE_STATE_DIR}/${kind}.jsonl`;
  if (sandboxId) await ensureSandboxSession(sandboxId, env);
  return env.SANDBOX.readFile(fileName).catch(() => "");
}

export function __resetSandboxSessionsForTests(): void {
  sessions.clear();
}

export const __sandboxTestUtils = { normalizeToolPath };
