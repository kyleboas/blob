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

// Safely parse JSON response with content-type check
async function parseResponse<T>(response: Response): Promise<T> {
  const ct = response.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await response.json() as T;
  }
  // If not JSON, throw with the text content
  const text = await response.text();
  throw new Error(`Expected JSON but got: ${text.slice(0, 100)}`);
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

  const timeout = opts.timeout || 30000;

  const response = await env.SANDBOX.fetch("http://sandbox/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, timeout }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sandbox error: ${response.status} ${error}`);
  }

  return await parseResponse<SandboxResult>(response);
}

// Start Codex device-code login flow
export async function startCodexLogin(env: Env): Promise<CodexLoginResult> {
  const response = await env.SANDBOX.fetch("http://sandbox/codex/login/start", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Codex login error: ${response.status} ${error}`);
  }

  return await parseResponse<CodexLoginResult>(response);
}

// Save Codex auth to persistent storage
export async function saveCodexAuth(env: Env): Promise<{ saved: boolean; message: string }> {
  const response = await env.SANDBOX.fetch("http://sandbox/codex/auth/save", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Codex auth save error: ${response.status} ${error}`);
  }

  return await parseResponse<{ saved: boolean; message: string }>(response);
}

// Run Codex with a prompt
export async function runCodex(
  prompt: string,
  env: Env,
  opts: { timeout?: number } = {}
): Promise<SandboxResult> {
  const timeout = opts.timeout || 120000;

  const response = await env.SANDBOX.fetch("http://sandbox/codex/run", {
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

  return await parseResponse<SandboxResult>(response);
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  try {
    const response = await env.SANDBOX.fetch("http://sandbox/health");
    
    if (response.ok) {
      // Check if response is JSON
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const data = await response.json() as { status?: string; proxied?: boolean };
        if (data.proxied === false) {
          return { ready: false, message: `Container not proxied: ${JSON.stringify(data)}` };
        }
        return { ready: true };
      }
      return { ready: true };
    }
    
    const body = await response.text();
    return { ready: false, message: `Health check failed: ${response.status} - ${body}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}