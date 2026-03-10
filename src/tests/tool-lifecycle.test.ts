import test from "node:test";
import assert from "node:assert/strict";
import { expireUnusedTools, validateTool } from "../agent/tool-lifecycle";
import type { Env } from "../core/types";

function createEnv(files: Record<string, string>) {
  const deleted: string[] = [];
  const sandbox = {
    exec: async (cmd: string) => {
      const path = cmd.replace("rm -f ", "").trim();
      deleted.push(path);
      delete files[path];
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    readFile: async (path: string) => files[path] ?? "",
    writeFile: async (path: string, content: string) => {
      files[path] = content;
    },
  };

  const env = {
    SANDBOX: sandbox,
    AGENT_DO: {} as DurableObjectNamespace,
    REPO_STORE: {} as R2Bucket,
  } as unknown as Env;

  return { env, deleted, files };
}

test("validateTool rejects scripts with secret-like content", async () => {
  const { env } = createEnv({ "/tool.sh": "token=supersecretvalue123456" });
  const result = await validateTool("/manifest.json", "/tool.sh", env);
  assert.equal(result.valid, false);
});

test("expireUnusedTools removes stale tools and keeps recent ones", async () => {
  const now = Date.now();
  const stale = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const manifestPath = "/manifest.json";
  const { env, deleted, files } = createEnv({
    [manifestPath]: JSON.stringify({
      tools: [
        { name: "old", path: "/tools/old.sh", createdAt: stale, lastUsedAt: stale },
        { name: "new", path: "/tools/new.sh", createdAt: fresh, lastUsedAt: fresh },
      ],
    }),
    "/tools/old.sh": "echo old",
    "/tools/new.sh": "echo new",
  });

  const expired = await expireUnusedTools(manifestPath, env, 30);
  assert.deepEqual(expired, ["old"]);
  assert.deepEqual(deleted, ["/tools/old.sh"]);
  const updated = JSON.parse(files[manifestPath]);
  assert.equal(updated.tools.length, 1);
  assert.equal(updated.tools[0].name, "new");
});
