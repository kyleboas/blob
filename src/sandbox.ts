import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
  const result = await env.SANDBOX.exec(command);
  return result;
}

// Start Codex device-code login flow
export async function startCodexLogin(env: Env): Promise<{ url: string; code?: string; instructions: string }> {
  // For Codex login, we need to run the codex CLI command
  const result = await env.SANDBOX.exec("codex login");
  
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
  const result = await env.SANDBOX.exec(`codex -f /tmp/prompt.txt`);
  return result;
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  try {
    // Try to exec a simple command to check if sandbox is responsive
    const result = await env.SANDBOX.exec("echo 'health check'");
    if (result.exitCode === 0) {
      return { ready: true };
    }
    return { ready: false, message: `Sandbox returned exit code ${result.exitCode}: ${result.stderr}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}