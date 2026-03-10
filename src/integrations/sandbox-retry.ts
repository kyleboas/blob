import type { Sandbox as SandboxType } from "@cloudflare/sandbox";

// Track whether the sandbox has been successfully started to avoid issuing a
// redundant start() HTTP request before every exec/read/write operation.
// Reset to null when a recoverable error forces a restart.
let sandboxStartedPromise: Promise<void> | null = null;

export function resetSandboxStartedState(): void {
  sandboxStartedPromise = null;
}

export async function ensureSandboxStarted(sandbox: SandboxType): Promise<void> {
  if (!("start" in sandbox && typeof sandbox.start === "function")) {
    return;
  }
  if (!sandboxStartedPromise) {
    sandboxStartedPromise = sandbox.start().catch((err) => {
      // If start fails, clear so the next caller retries.
      sandboxStartedPromise = null;
      throw err;
    });
  }
  await sandboxStartedPromise;
}

const RECOVERABLE_SANDBOX_ERRORS = [
  /withSession callback failed/i,
  /not ready or shell has died/i,
];

export function isRecoverableSandboxError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RECOVERABLE_SANDBOX_ERRORS.some((pattern) => pattern.test(message));
}

export async function runSandboxOperation<T>(sandbox: SandboxType, operation: () => Promise<T>): Promise<T> {
  await ensureSandboxStarted(sandbox);
  try {
    return await operation();
  } catch (err) {
    if (!isRecoverableSandboxError(err)) {
      throw err;
    }

    console.warn("[sandbox] recoverable session failure detected; restarting and retrying once", {
      error: err instanceof Error ? err.message : String(err),
    });
    resetSandboxStartedState();
    await ensureSandboxStarted(sandbox);
    return operation();
  }
}
