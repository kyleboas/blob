// src/sandbox-worker.ts
import {
  getSandbox,
  proxyToSandbox,
  Sandbox as SandboxDO,
  type Sandbox as SandboxType,
} from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

// Wrangler "class_name = Sandbox" will look for this exact export.
export class Sandbox extends SandboxDO {}

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

  // Optional: expose RPC-ish helpers if your main worker calls them via service binding
  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    const result = await sandbox.exec(command);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    await sandbox.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    const result = await sandbox.readFile(path);
    return result.content ?? "";
  }
}