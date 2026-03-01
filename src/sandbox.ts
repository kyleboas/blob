import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./types";

interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeInSandbox(
  command: string,
  env: Env,
  opts: { instanceId?: string } = {}
): Promise<SandboxResult> {
  const sandbox = getSandbox(env.Sandbox, opts.instanceId ?? "default");
  const result = await sandbox.exec(command);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? (result.success ? 0 : 1),
  };
}

export async function runCodex(
  prompt: string,
  env: Env,
  opts: { instanceId?: string } = {}
): Promise<SandboxResult> {
  const sandbox = getSandbox(env.Sandbox, opts.instanceId ?? "default");
  // Restore auth from persistent storage if available
  await sandbox.exec(
    "[ -f /workspace/.codex-auth/auth.json ] && mkdir -p ~/.codex && cp /workspace/.codex-auth/auth.json ~/.codex/ || true"
  );
  const escaped = prompt.replace(/"/g, '\\"');
  const result = await sandbox.exec(`codex --quiet "${escaped}"`);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? (result.success ? 0 : 1),
  };
}

export async function startCodexLogin(env: Env): Promise<{ url: string; code?: string; instructions: string }> {
  const sandbox = getSandbox(env.Sandbox, "auth");
  // Background the login process so it keeps polling for the OAuth callback,
  // then read its output after 3s to capture the device code URL.
  const result = await sandbox.exec(
    "bash -c 'codex login > /tmp/codex-login.out 2>&1 & sleep 3; cat /tmp/codex-login.out'"
  );
  const output = result.stdout ?? "";

  let url = "https://auth.openai.com/codex/device";
  let code: string | undefined;
  for (const line of output.split("\n")) {
    if (line.includes("https://") && line.includes("device")) url = line.trim();
    if (line.trim().length === 8 && /^[a-zA-Z0-9]+$/.test(line.trim())) code = line.trim();
  }

  return {
    url,
    code,
    instructions: `1. Open ${url}\n2. Enter code: ${code}\n3. Complete login\n4. Run /codex auth save`,
  };
}

export async function saveCodexAuth(env: Env): Promise<{ saved: boolean; message: string }> {
  const sandbox = getSandbox(env.Sandbox, "auth");
  const result = await sandbox.exec(
    "mkdir -p /workspace/.codex-auth && cp ~/.codex/auth.json /workspace/.codex-auth/"
  );
  if ((result.exitCode ?? 0) !== 0) {
    throw new Error("No auth.json found. Complete login first.");
  }
  return { saved: true, message: "Auth credentials persisted to storage" };
}

export async function sandboxStatus(env: Env): Promise<{ ready: boolean; message?: string }> {
  try {
    const sandbox = getSandbox(env.Sandbox, "default");
    await sandbox.exec("echo ok");
    return { ready: true };
  } catch (err) {
    return { ready: false, message: `Connection failed: ${err}` };
  }
}
