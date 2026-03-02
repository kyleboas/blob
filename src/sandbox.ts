import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CodexLoginResult {
  url: string;
  code?: string;
  instructions: string;
}

// Validate command before execution
function validateCommand(command: string): { valid: boolean; error?: string } {
  const dangerous = [
    /rm\s+-rf\s+\//,
    /:\(\)\{\s*:\|:\s*\&\s*\}.*:\)/,
  ];

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
  opts: { timeout?: number; signal?: AbortSignal } = {}
): Promise<SandboxResult> {
  const validation = validateCommand(command);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const sandbox = getSandbox(env.SANDBOX_DO, "agent");
  const result = await sandbox.exec(command, { timeout: opts.timeout ?? 30000 });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

// Start Codex device-code login flow
export async function startCodexLogin(env: Env): Promise<CodexLoginResult> {
  const sandbox = getSandbox(env.SANDBOX_DO, "agent");
  const result = await sandbox.exec("codex login 2>&1", { timeout: 30000 });
  const output = result.stdout + result.stderr;

  const urlMatch = output.match(/https:\/\/[^\s\)\]]+/);
  const codeMatch = output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8})\b/);

  if (!urlMatch || !codeMatch) {
    throw new Error(`Could not parse device-login details from codex output: ${output}`);
  }

  const url = urlMatch[0];
  const code = codeMatch[1];
  return {
    url,
    code,
    instructions: `1. Open ${url} on your device\n2. Enter code: ${code}\n3. Complete login\n4. Call /codex/auth/save to persist credentials`,
  };
}

// Save Codex auth to persistent storage
export async function saveCodexAuth(env: Env): Promise<{ saved: boolean; message: string }> {
  const sandbox = getSandbox(env.SANDBOX_DO, "agent");
  const result = await sandbox.exec(
    "mkdir -p /workspace/.codex-auth && cp ~/.codex/auth.json /workspace/.codex-auth/auth.json",
    { timeout: 10000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Codex auth save failed: ${result.stderr || result.stdout}`);
  }

  return { saved: true, message: "Auth credentials persisted to storage" };
}

// Run Codex with a prompt
export async function runCodex(
  prompt: string,
  env: Env,
  opts: { timeout?: number } = {}
): Promise<SandboxResult> {
  const sandbox = getSandbox(env.SANDBOX_DO, "agent");
  const timeout = opts.timeout ?? 120000;

  const authCheck = await sandbox.exec("test -f ~/.codex/auth.json && echo yes || echo no", { timeout: 5000 });
  if (authCheck.stdout.trim() !== "yes") {
    throw new Error("Not authenticated. Run /codex login first.");
  }

  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const result = await sandbox.exec(`codex --quiet '${escapedPrompt}'`, { timeout });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  try {
    const sandbox = getSandbox(env.SANDBOX_DO, "agent");
    await sandbox.exec("echo ok", { timeout: 10000 });
    return { ready: true };
  } catch (err) {
    return { ready: false, message: `Sandbox not ready: ${err}` };
  }
}
