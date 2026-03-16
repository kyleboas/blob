// src/sandbox-worker.ts
import {
  getSandbox,
  proxyToSandbox,
  Sandbox as SandboxDO,
  type Sandbox as SandboxType,
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
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    await withOperationLog("start", { sandbox: "agent" }, () => ensureSandboxStarted(sandbox));
  }

  // Initialize sandbox - run restore-auth on first use
  async init(): Promise<{ restored: boolean; message: string }> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
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
  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    const result = await withOperationLog(
      "exec",
      { sandbox: "agent", commandKind: classifyCommandKind(command), commandLength: command.length },
      () => runSandboxOperation(sandbox, () => sandbox.exec(command)),
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

  async writeFile(path: string, content: string): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    await withOperationLog(
      "writeFile",
      { sandbox: "agent", path: summarizePath(path), contentBytes: estimateBytes(content) },
      () => runSandboxOperation(sandbox, () => sandbox.writeFile(path, content)),
    );
  }

  async readFile(path: string): Promise<string> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    const result = await withOperationLog(
      "readFile",
      { sandbox: "agent", path: summarizePath(path) },
      () => runSandboxOperation(sandbox, () => sandbox.readFile(path)),
      (value) => ({ contentBytes: estimateBytes(value.content ?? "") }),
    );
    return result.content ?? "";
  }
}
