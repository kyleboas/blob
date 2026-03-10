import { getSecretPatterns } from "../core/safety";
import type { Env } from "../core/types";

type ToolRecord = { name: string; path: string; createdAt: string; lastUsedAt: string };
type ToolManifest = { tools: ToolRecord[] };

function hasSecret(content: string, env: Env): boolean {
  return getSecretPatterns(env).some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}

export async function validateTool(manifestPath: string, toolPath: string, env: Env): Promise<{ valid: boolean; reason?: string }> {
  void manifestPath;
  const content = await env.SANDBOX.readFile(toolPath);
  if (hasSecret(content, env)) {
    return { valid: false, reason: "Tool contains potential secret material" };
  }
  return { valid: true };
}

export async function expireUnusedTools(manifestPath: string, env: Env, maxAgeDays: number): Promise<string[]> {
  let manifest: ToolManifest;
  try {
    const raw = await env.SANDBOX.readFile(manifestPath);
    manifest = JSON.parse(raw) as ToolManifest;
  } catch (err) {
    console.error("expireUnusedTools manifest read failed", err);
    return [];
  }
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const keep: ToolRecord[] = [];
  const expired: ToolRecord[] = [];

  for (const tool of manifest.tools ?? []) {
    const last = new Date(tool.lastUsedAt).getTime();
    if (Number.isFinite(last) && now - last > maxAgeMs) {
      expired.push(tool);
    } else {
      keep.push(tool);
    }
  }

  for (const tool of expired) {
    await env.SANDBOX.exec(`rm -f ${tool.path}`);
  }

  await env.SANDBOX.writeFile(manifestPath, JSON.stringify({ tools: keep }, null, 2));
  return expired.map((tool) => tool.name);
}
