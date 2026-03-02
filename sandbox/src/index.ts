import { getSandbox, proxyToSandbox, Sandbox as SandboxDO, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

export class Sandbox extends SandboxDO {}

interface Env {
  // binding name must match wrangler durable_objects.bindings.name
  Sandbox: DurableObjectNamespace<SandboxType>;
}

export default class SandboxWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const proxyResponse = await proxyToSandbox(request, this.env);
    if (proxyResponse) return proxyResponse;
    return new Response("blob-sandbox", { status: 200 });
  }

  async exec(command: string): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
    const sandbox = getSandbox(this.env.Sandbox, "agent");
    const result = await sandbox.exec(command);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? (result.success ? 0 : 1)
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