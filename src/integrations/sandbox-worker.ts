// src/sandbox-worker.ts
import {
  getSandbox,
  proxyToSandbox,
  Sandbox as SandboxDO,
  type Sandbox as SandboxType,
  type ExecutionSession,
  type SessionOptions,
} from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";
import { classifyCommandKind, estimateBytes, summarizePath } from "./sandbox-observability";
import { ensureSandboxStarted, runSandboxOperation } from "./sandbox-retry";

async function withOperationLog<T>(
  operation: string,
  details: Record<string, unknown>,
  fn: () => Promise<T>,
  onSuccess?: (value: T) => Record<string, unknown>,
): Promise<T> {
  const startedAt = Date.now();
  console.log(`[sandbox] ${operation} start`, details);
  try {
    const value = await fn();
    console.log(`[sandbox] ${operation} ok`, {
      ...details,
      durationMs: Date.now() - startedAt,
      ...(onSuccess ? onSuccess(value) : {}),
    });
    return value;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[sandbox] ${operation} failed`, {
      ...details,
      durationMs: Date.now() - startedAt,
      error: error.message,
      name: error.name,
    });
    throw error;
  }
}

// Wrangler "class_name = Sandbox" will look for this exact export.
export class Sandbox extends SandboxDO {
  async alarm(): Promise<void> {
    const startedAt = Date.now();
    try {
      console.log("[alarm] fired", new Date().toISOString());
      // super.alarm expects a context; Cloudflare doesn't pass one to your override.
      await (super.alarm as unknown as (arg: any) => Promise<void>)({ isRetry: false });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[alarm] failed", {
        msg: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    } finally {
      console.log("[alarm] done", { ms: Date.now() - startedAt });
    }
  }
}

interface Env {
  Sandbox: DurableObjectNamespace<SandboxType>;
}

type SessionRequestOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  isolation?: boolean;
};

type ExecRequestOptions = SessionRequestOptions & {
  sessionId?: string;
  timeout?: number;
  encoding?: string;
};

type FileRequestOptions = {
  sessionId?: string;
  encoding?: string;
};

function getAgentSandbox(env: Env): SandboxType {
  return getSandbox(env.Sandbox, "agent");
}

function toSessionOptions(sessionId: string, options?: SessionRequestOptions): SessionOptions {
  return {
    id: sessionId,
    cwd: options?.cwd,
    env: options?.env,
    isolation: options?.isolation,
  };
}

async function getOrCreateSession(
  sandbox: SandboxType,
  sessionId: string,
  options?: SessionRequestOptions,
): Promise<ExecutionSession> {
  const session = await runSandboxOperation(sandbox, async () => {
    try {
      return await sandbox.getSession(sessionId);
    } catch {
      try {
        return await sandbox.createSession(toSessionOptions(sessionId, options));
      } catch {
        return sandbox.getSession(sessionId);
      }
    }
  });

  if (options?.env && Object.keys(options.env).length > 0) {
    await runSandboxOperation(sandbox, () => session.setEnvVars(options.env!));
  }

  return session;
}

export default class SandboxWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const proxied = await proxyToSandbox(request, this.env);
    if (proxied) return proxied;

    // Fallback response (useful health check) — return JSON so callers can safely resp.json()
    return new Response(
      JSON.stringify({
        ok: true,
        service: "blob-sandbox",
        proxied: false,
        hint: "Request was not routed to the container via proxyToSandbox()",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }


  async start(): Promise<void> {
    const sandbox = getAgentSandbox(this.env);
    await withOperationLog("start", { sandbox: "agent" }, () => ensureSandboxStarted(sandbox));
  }

  async ensureSession(
    sessionId: string,
    options?: SessionRequestOptions,
  ): Promise<{ id: string }> {
    const sandbox = getAgentSandbox(this.env);
    const session = await withOperationLog(
      "ensureSession",
      { sandbox: "agent", sessionId },
      () => getOrCreateSession(sandbox, sessionId, options),
      () => ({ sessionId }),
    );
    return { id: session.id };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sandbox = getAgentSandbox(this.env);
    await withOperationLog(
      "deleteSession",
      { sandbox: "agent", sessionId },
      async () => {
        try {
          await runSandboxOperation(sandbox, () => sandbox.deleteSession(sessionId));
        } catch (err: unknown) {
          console.warn("[sandbox] deleteSession skipped", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  }

  // Initialize sandbox - run restore-auth on first use
  async init(): Promise<{ restored: boolean; message: string }> {
    const sandbox = getAgentSandbox(this.env);
    try {
      const result = await withOperationLog(
        "init",
        { sandbox: "agent", commandKind: "python", commandLength: "python3 /restore-auth.py".length },
        () => runSandboxOperation(sandbox, () => sandbox.exec("python3 /restore-auth.py")),
        (value) => ({
          exitCode: value.exitCode ?? (value.success ? 0 : 1),
          stdoutBytes: estimateBytes(value.stdout ?? ""),
          stderrBytes: estimateBytes(value.stderr ?? ""),
        }),
      );
      const restored = result.success && !result.stderr?.includes("failed");
      return {
        restored,
        message: restored ? "Auth restored" : "No auth to restore or restore failed",
      };
    } catch (e) {
      return { restored: false, message: `Restore error: ${e}` };
    }
  }

  // Run command in sandbox
  async exec(command: string, options?: ExecRequestOptions): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sandbox = getAgentSandbox(this.env);
    const result = await withOperationLog(
      "exec",
      {
        sandbox: "agent",
        sessionId: options?.sessionId,
        commandKind: classifyCommandKind(command),
        commandLength: command.length,
      },
      async () => {
        if (options?.sessionId) {
          const session = await getOrCreateSession(sandbox, options.sessionId, options);
          return session.exec(command, {
            timeout: options.timeout,
            cwd: options.cwd,
            env: options.env,
            encoding: options.encoding,
          });
        }
        return runSandboxOperation(sandbox, () => sandbox.exec(command, {
          timeout: options?.timeout,
          cwd: options?.cwd,
          env: options?.env,
          encoding: options?.encoding,
        }));
      },
      (value) => ({
        exitCode: value.exitCode ?? (value.success ? 0 : 1),
        stdoutBytes: estimateBytes(value.stdout ?? ""),
        stderrBytes: estimateBytes(value.stderr ?? ""),
      }),
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
    };
  }

  async writeFile(path: string, content: string, options?: FileRequestOptions): Promise<void> {
    const sandbox = getAgentSandbox(this.env);
    await withOperationLog(
      "writeFile",
      {
        sandbox: "agent",
        sessionId: options?.sessionId,
        path: summarizePath(path),
        contentBytes: estimateBytes(content),
      },
      async () => {
        if (options?.sessionId) {
          const session = await getOrCreateSession(sandbox, options.sessionId);
          await session.writeFile(path, content, { encoding: options.encoding });
          return;
        }
        await runSandboxOperation(sandbox, () => sandbox.writeFile(path, content, { encoding: options?.encoding }));
      },
    );
  }

  async readFile(path: string, options?: FileRequestOptions): Promise<string> {
    const sandbox = getAgentSandbox(this.env);
    const result = await withOperationLog(
      "readFile",
      { sandbox: "agent", sessionId: options?.sessionId, path: summarizePath(path) },
      async () => {
        if (options?.sessionId) {
          const session = await getOrCreateSession(sandbox, options.sessionId);
          return session.readFile(path, { encoding: options.encoding });
        }
        return runSandboxOperation(sandbox, () => sandbox.readFile(path, { encoding: options?.encoding }));
      },
      (value) => ({ contentBytes: estimateBytes(value.content ?? "") }),
    );
    return result.content ?? "";
  }

  async exists(path: string, options?: { sessionId?: string }): Promise<{ exists: boolean }> {
    const sandbox = getAgentSandbox(this.env);
    const result = await withOperationLog(
      "exists",
      { sandbox: "agent", sessionId: options?.sessionId, path: summarizePath(path) },
      async () => {
        if (options?.sessionId) {
          const session = await getOrCreateSession(sandbox, options.sessionId);
          return session.exists(path);
        }
        return runSandboxOperation(sandbox, () => sandbox.exists(path));
      },
      (value) => ({ exists: value.exists }),
    );
    return { exists: result.exists };
  }

  async renameFile(oldPath: string, newPath: string, options?: { sessionId?: string }): Promise<void> {
    const sandbox = getAgentSandbox(this.env);
    await withOperationLog(
      "renameFile",
      {
        sandbox: "agent",
        sessionId: options?.sessionId,
        oldPath: summarizePath(oldPath),
        newPath: summarizePath(newPath),
      },
      async () => {
        if (options?.sessionId) {
          const session = await getOrCreateSession(sandbox, options.sessionId);
          await session.renameFile(oldPath, newPath);
          return;
        }
        await runSandboxOperation(sandbox, () => sandbox.renameFile(oldPath, newPath));
      },
    );
  }

  async gitCheckout(
    repoUrl: string,
    options?: { sessionId?: string; branch?: string; targetDir?: string; depth?: number; cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<{ success: boolean; targetDir?: string; branch?: string }> {
    const sandbox = getAgentSandbox(this.env);
    await withOperationLog(
      "gitCheckout",
      {
        sandbox: "agent",
        sessionId: options?.sessionId,
        targetDir: options?.targetDir ?? "/workspace",
        branch: options?.branch ?? "default",
        depth: options?.depth ?? "full",
      },
      async () => {
        if (options?.sessionId) {
          const session = await getOrCreateSession(sandbox, options.sessionId, {
            cwd: options.cwd,
            env: options.env,
          });
          await session.gitCheckout(repoUrl, {
            branch: options.branch,
            targetDir: options.targetDir,
            depth: options.depth,
          });
          return;
        }
        await runSandboxOperation(sandbox, () => sandbox.gitCheckout(repoUrl, {
          branch: options?.branch,
          targetDir: options?.targetDir,
          depth: options?.depth,
        }));
      },
    );
    return {
      success: true,
      targetDir: options?.targetDir,
      branch: options?.branch,
    };
  }

  async setEnvVars(envVars: Record<string, string | undefined>): Promise<void> {
    const sandbox = getAgentSandbox(this.env);
    await withOperationLog(
      "setEnvVars",
      { sandbox: "agent", envVarCount: Object.keys(envVars).length },
      () => runSandboxOperation(sandbox, () => sandbox.setEnvVars(envVars)),
    );
  }
}
