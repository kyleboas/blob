import type { Env } from "./types";

// Cloudflare Containers types (available at runtime)
declare class Container {
  defaultPort?: number;
  sleepAfter?: string;
  fetch(request: Request): Promise<Response>;
}

declare function getContainer(binding: Container, id: string): Container;

// Cloudflare Container binding for sandboxed execution
export class BlobSandbox extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Validate command before execution
function validateCommand(command: string): { valid: boolean; error?: string } {
  // Block dangerous commands
  const dangerous = [
    /rm\s+-rf\s+\//,
    />\s*\/dev\/null/,
    /:\(\)\{\s*:\|:\s*&\s*\}.*:\)/, // Fork bomb
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
  opts: { sessionId?: string; timeout?: number; signal?: AbortSignal } = {}
): Promise<SandboxResult> {
  // Validate command
  const validation = validateCommand(command);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (!env.BLOB_SANDBOX) {
    throw new Error("BLOB_SANDBOX binding not found");
  }

  const sessionId = opts.sessionId || "default";
  const container = getContainer(env.BLOB_SANDBOX, sessionId);

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeout = opts.timeout || 30000;
  
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Sandbox timeout after ${timeout}ms`));
  }, timeout);

  // Link external signal if provided
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      controller.abort(opts.signal?.reason);
    });
  }

  try {
    const response = await container.fetch("http://container/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, timeout }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sandbox error: ${response.status} ${error}`);
    }

    return await response.json() as SandboxResult;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  if (!env.BLOB_SANDBOX) {
    return { ready: false, message: "BLOB_SANDBOX binding not found" };
  }

  try {
    const container = getContainer(env.BLOB_SANDBOX, "status-check");
    const response = await container.fetch("http://container/health");
    
    if (response.ok) {
      return { ready: true };
    }
    return { ready: false, message: `Health check failed: ${response.status}` };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}
