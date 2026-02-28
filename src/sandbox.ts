import type { Env } from "./types";

// Cloudflare Container binding for sandboxed execution
export class SandboxContainer extends Container {
  defaultPort = 8080;  // Port your sandbox container listens on
  sleepAfter = "5m";   // Stop after 5 min of inactivity
}

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeInSandbox(
  command: string,
  env: Env,
  opts: { sessionId?: string; timeout?: number } = {}
): Promise<SandboxResult> {
  if (!env.SANDBOX_CONTAINER) {
    throw new Error("SANDBOX_CONTAINER binding not found");
  }

  const sessionId = opts.sessionId || "default";
  const container = getContainer(env.SANDBOX_CONTAINER, sessionId);

  const response = await container.fetch("http://container/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command,
      timeout: opts.timeout || 30000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sandbox error: ${response.status} ${error}`);
  }

  return await response.json() as SandboxResult;
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  if (!env.SANDBOX_CONTAINER) {
    return { ready: false, message: "SANDBOX_CONTAINER binding not found" };
  }

  try {
    const container = getContainer(env.SANDBOX_CONTAINER, "status-check");
    const response = await container.fetch("http://container/health");
    
    if (response.ok) {
      return { ready: true };
    }
    return { ready: false, message: `Health check failed: ${response.status}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}
