import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeInSandbox(
  command: string,
  env: Env,
  opts: { timeout?: number } = {}
): Promise<SandboxResult> {
  if (!env.SANDBOX_CONTAINER_URL) {
    throw new Error("Sandbox not configured. Set SANDBOX_CONTAINER_URL.");
  }

  const response = await fetch(env.SANDBOX_CONTAINER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${env.SANDBOX_TOKEN || ""}`,
    },
    body: JSON.stringify({
      command,
      timeout: opts.timeout || 30000, // 30s default
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sandbox error: ${response.status} ${error}`);
  }

  return await response.json() as SandboxResult;
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  if (!env.SANDBOX_CONTAINER_URL) {
    return { ready: false, message: "SANDBOX_CONTAINER_URL not set" };
  }

  try {
    const response = await fetch(`${env.SANDBOX_CONTAINER_URL}/status`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${env.SANDBOX_TOKEN || ""}`,
      },
    });
    
    if (response.ok) {
      return { ready: true };
    }
    return { ready: false, message: `Status check failed: ${response.status}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}
