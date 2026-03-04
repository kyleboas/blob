import test from "node:test";
import assert from "node:assert/strict";
import { PiAgent } from "../agent/pi-agent";
import { __resetSandboxSessionsForTests, cleanupSandboxForJob, readTool, teardownIdleSandboxes, writeTool } from "../integrations/sandbox";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const files = new Map<string, string>();
  files.set("/workspace/blob/src/a.txt", "hello world");

  const env = {
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
    },
    REPO_STORE: {
      put: async (_k: string, _v: string) => {},
      get: async () => null,
    },
    AI_GATEWAY_BASE_URL: "https://example.com",
    AI_GATEWAY_TOKEN: "x",
    ...overrides,
  } as any;

  return { env, files };
}

test("sandbox tools enforce path allowlist and atomic writes", async () => {
  __resetSandboxSessionsForTests();
  const { env, files } = makeEnv();

  await writeTool("src/new.txt", "content", env, "s1");
  assert.equal(files.get("/workspace/blob/src/new.txt"), "content");

  await assert.rejects(() => readTool("../secrets", env, "s1"));
});

test("sandbox idle teardown removes expired sessions", async () => {
  __resetSandboxSessionsForTests();
  const { env } = makeEnv({ SANDBOX_IDLE_TIMEOUT_MS: "0" });
  await writeTool("src/idle.txt", "x", env, "idle-session");
  const removed = await teardownIdleSandboxes(env, Date.now() + 1);
  assert.deepEqual(removed, ["idle-session"]);
});

test("sandbox cleanup keeps failed sessions when configured", async () => {
  __resetSandboxSessionsForTests();
  const { env } = makeEnv({ SANDBOX_KEEP_ON_FAILURE: "true" });
  await writeTool("src/fail.txt", "x", env, "fail-session");
  await cleanupSandboxForJob("fail-session", "failed", env);
  const removed = await teardownIdleSandboxes({ ...env, SANDBOX_IDLE_TIMEOUT_MS: "0" }, Date.now() + 1);
  assert.deepEqual(removed, ["fail-session"]);
});

test("agent enforces model call limit and reports progress", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const { env } = makeEnv({
    HEARTBEAT_MODEL_CALL_LIMIT: "2",
    AI_GATEWAY_BASE_URL: "https://gateway.example",
  });

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: calls === 1 ? "TOOL: bash\nARG: {\"command\":\"echo hi\"}" : "final",
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const progress: string[] = [];
  const agent = new PiAgent(env, "blob");
  const result = await agent.run("test", { onProgress: (msg) => progress.push(msg), sandboxId: "a1" });

  assert.equal(result, "final");
  assert.equal(progress.length, 1);
  globalThis.fetch = originalFetch;
});

test("agent pauses after consecutive tool failures", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const { env } = makeEnv({ MAX_CONSECUTIVE_TOOL_FAILURES: "1" });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "TOOL: read\nARG: {\"path\":\"missing.txt\"}" } }],
      }),
      { status: 200 },
    )) as typeof fetch;

  const agent = new PiAgent(env, "blob");
  const result = await agent.run("test", { sandboxId: "a2" });
  assert.match(result, /consecutive tool failures/);
  globalThis.fetch = originalFetch;
});

test("agent halts when daily token ceiling is reached", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const { env } = makeEnv({ DAILY_TOKEN_CEILING: "1" });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "This is a long response that consumes tokens." } }],
      }),
      { status: 200 },
    )) as typeof fetch;

  const agent = new PiAgent(env, "blob");
  await agent.run("first", { sandboxId: "a3" });
  const second = await agent.run("second", { sandboxId: "a3" });
  assert.match(second, /Daily token ceiling reached/);
  globalThis.fetch = originalFetch;
});
