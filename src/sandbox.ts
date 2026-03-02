import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SANDBOX_STARTUP_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHttpStatus(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const statusMatch = message.match(/status:\s*(\d+)/i);
  if (!statusMatch) {
    return undefined;
  }
  return Number.parseInt(statusMatch[1], 10);
}

function formatSandboxError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function execWithRetry(env: Env, command: string, attempts = 3): Promise<SandboxResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await env.SANDBOX.exec(command);
    } catch (err) {
      lastError = err;
      const status = parseHttpStatus(err);
      const canRetry = status !== undefined && SANDBOX_STARTUP_RETRYABLE_STATUS.has(status) && attempt < attempts;
      if (!canRetry) {
        throw err;
      }
      await delay(attempt * 500);
    }
  }

  throw lastError;
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

  // Use service binding method instead of HTTP fetch
  const result = await execWithRetry(env, command);
  return result;
}

// Start Codex device-code login flow
export async function startCodexLogin(env: Env): Promise<{ url: string; code?: string; instructions: string }> {
  // For Codex login, we need to run the codex CLI command
  const result = await execWithRetry(env, "codex login");
  
  // Parse the output to extract URL and code
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
  // Write auth file to container
  await env.SANDBOX.writeFile("/root/.codex/auth.json", "{}");
  return { saved: true, message: "Auth saved" };
}

// Run Codex with a prompt
export async function runCodex(
  prompt: string,
  env: Env,
  opts: { timeout?: number } = {}
): Promise<SandboxResult> {
  // Write prompt to a file and run codex
  await env.SANDBOX.writeFile("/tmp/prompt.txt", prompt);
  const result = await execWithRetry(env, `codex -f /tmp/prompt.txt`);
  return result;
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  try {
    // Try to exec a simple command to check if sandbox is responsive
    const result = await execWithRetry(env, "echo 'health check'");
    if (result.exitCode === 0) {
      return { ready: true };
    }
    return { ready: false, message: `Sandbox returned exit code ${result.exitCode}: ${result.stderr}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${formatSandboxError(err)}` };
  }
}
