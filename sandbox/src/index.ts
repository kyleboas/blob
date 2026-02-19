import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace;
}

export default class SandboxService extends WorkerEntrypoint<Env> {
  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sandbox = getSandbox(this.env.Sandbox, "default");
    const result = await sandbox.exec(command);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const sandbox = getSandbox(this.env.Sandbox, "default");
    await sandbox.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    const sandbox = getSandbox(this.env.Sandbox, "default");
    return sandbox.readFile(path);
  }
}
