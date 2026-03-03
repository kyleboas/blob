// src/sandbox-worker.ts
import {
  getSandbox,
  proxyToSandbox,
  Sandbox as SandboxDO,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Wrangler "class_name = Sandbox" will look for this exact export.
export class Sandbox extends SandboxDO {
  async alarm(): Promise<void> {
    const startedAt = Date.now();
    try {
      console.log("[alarm] fired", new Date().toISOString());
      await withTimeout(super.alarm(), 30_000, "alarm super.alarm()");
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

async function ensureSandboxStarted(sandbox: SandboxType): Promise<void> {
  if ("start" in sandbox && typeof sandbox.start === "function") {
    await sandbox.start();
  }
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
    await ensureSandboxStarted(sandbox);
  }

  // Initialize sandbox - run restore-auth on first use
  async init(): Promise<{ restored: boolean; message: string }> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    try {
      await ensureSandboxStarted(sandbox);
      const result = await sandbox.exec("python3 /restore-auth.py");
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
    await ensureSandboxStarted(sandbox);
    const result = await sandbox.exec(command);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    await ensureSandboxStarted(sandbox);
    await sandbox.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    await ensureSandboxStarted(sandbox);
    const result = await sandbox.readFile(path);
    return result.content ?? "";
  }
}
