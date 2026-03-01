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

// Get the Sandbox DO stub
async function getSandboxDO(env: Env): Promise<DurableObjectStub> {
  if (!env.SANDBOX_DO) throw new Error("SANDBOX_DO binding not found");
  const id = env.SANDBOX_DO.idFromName("default");
  return env.SANDBOX_DO.get(id);
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

  const do_ = await getSandboxDO(env);
  const timeout = opts.timeout || 30000;

  const response = await do_.fetch("http://sandbox/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, timeout }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sandbox error: ${response.status} ${error}`);
  }

  return await response.json() as SandboxResult;
}

// Start Codex device-code login flow
export async function startCodexLogin(env: Env): Promise<CodexLoginResult> {
  const do_ = await getSandboxDO(env);

  const response = await do_.fetch("http://sandbox/codex/login/start", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Codex login error: ${response.status} ${error}`);
  }

  return await response.json() as CodexLoginResult;
}

// Save Codex auth to persistent storage
export async function saveCodexAuth(env: Env): Promise<{ saved: boolean; message: string }> {
  const do_ = await getSandboxDO(env);

  const response = await do_.fetch("http://sandbox/codex/auth/save", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Codex auth save error: ${response.status} ${error}`);
  }

  return await response.json() as { saved: boolean; message: string };
}

// Run Codex with a prompt
export async function runCodex(
  prompt: string,
  env: Env,
  opts: { timeout?: number } = {}
): Promise<SandboxResult> {
  const do_ = await getSandboxDO(env);
  const timeout = opts.timeout || 120000; // Default 2 min for Codex

  const response = await do_.fetch("http://sandbox/codex/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, timeout }),
  });

  if (response.status === 401) {
    throw new Error("Not authenticated. Run /codex login first.");
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Codex run error: ${response.status} ${error}`);
  }

  return await response.json() as SandboxResult;
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  if (!env.SANDBOX_DO) {
    return { ready: false, message: "SANDBOX_DO binding not found" };
  }

  try {
    const do_ = await getSandboxDO(env);
    const response = await do_.fetch("http://sandbox/health");

    if (!response.ok) {
      return { ready: false, message: `Health check failed: ${response.status}` };
    }

    const body = await response.json() as { status?: string; ready?: boolean; error?: string };
    if (body.ready === false) {
      return { ready: false, message: body.error || "Container not ready" };
    }

    return { ready: true };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}