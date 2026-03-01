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

// Get sandbox DO stub
function getSandboxStub(env: Env) {
  const id = env.SANDBOX_DO.idFromName("agent");
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

  const stub = getSandboxStub(env);
  const timeout = opts.timeout || 30000;

  const response = await stub.fetch("http://sandbox/execute", {
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
  const stub = getSandboxStub(env);

  const response = await stub.fetch("http://sandbox/codex/login/start", {
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
  const stub = getSandboxStub(env);

  const response = await stub.fetch("http://sandbox/codex/auth/save", {
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
  const stub = getSandboxStub(env);
  const timeout = opts.timeout || 120000;

  const response = await stub.fetch("http://sandbox/codex/run", {
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
  try {
    const stub = getSandboxStub(env);
    const response = await stub.fetch("http://sandbox/health");
    const body = await response.text();

    let parsed: {
      status?: string;
      mode?: string;
      reason?: string;
      hint?: string;
      lookedFor?: string[];
      envKeys?: string[];
    } | undefined;

    try {
      parsed = JSON.parse(body) as {
        status?: string;
        mode?: string;
        reason?: string;
        hint?: string;
        lookedFor?: string[];
        envKeys?: string[];
      };
    } catch {
      // Non-JSON health payloads are supported for compatibility.
    }

    if (!response.ok) {
      return { ready: false, message: `Health check failed: ${response.status} - ${body}` };
    }

    // Detect fallback/degraded health responses from the DO (no sandbox container attached).
    // Fallback responds with HTTP 200 and { status: "degraded", mode: "fallback", ... }.
    const degraded = parsed?.status === "degraded" || parsed?.mode === "fallback";
    if (degraded) {
      const details: string[] = [];

      if (parsed?.reason) {
        details.push(parsed.reason);
      }

      if (parsed?.hint) {
        details.push(parsed.hint);
      }

      if (Array.isArray(parsed?.lookedFor) && Array.isArray(parsed?.envKeys)) {
        const missing = parsed.lookedFor
          .filter((name) => name !== "state.container")
          .filter((name) => !parsed!.envKeys!.includes(name));
        if (missing.length > 0) {
          details.push(`missing bindings: ${missing.join(", ")}`);
        }
      }

      return {
        ready: false,
        message: details.length > 0
          ? `Sandbox is in fallback mode (${details.join("; ")})`
          : "Sandbox is in fallback mode",
      };
    }

    return { ready: true };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}
