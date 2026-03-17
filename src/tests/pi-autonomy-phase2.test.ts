import test from "node:test";
import assert from "node:assert/strict";
import { PiAgent } from "../agent/pi-agent";
import { __resetSandboxSessionsForTests, __sandboxTestUtils, appendWorkspaceState, cleanupSandboxForJob, readTool, teardownIdleSandboxes, writeTool } from "../integrations/sandbox";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const files = new Map<string, string>();
  files.set("/workspace/blob/src/a.txt", "hello world");
  const dailyTotals = new Map<string, number>();

  const doStub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/daily-tokens") && init?.method === "POST") {
        const payload = JSON.parse(String(init.body ?? "{}")) as { date?: string; tokens?: number };
        const date = payload.date ?? new Date().toISOString().slice(0, 10);
        const next = (dailyTotals.get(date) ?? 0) + Number(payload.tokens ?? 0);
        dailyTotals.set(date, next);
        return new Response(JSON.stringify({ date, totalTokens: next }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  } as DurableObjectStub;

  const env = {
    AGENT_DO: {
      idFromName: () => "blob" as DurableObjectId,
      get: () => doStub,
    } as DurableObjectNamespace,
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("test -d ")) {
          const match = command.match(/test -d '([^']+)'/);
          const dir = match?.[1];
          const exists = dir ? [...files.keys()].some((path) => path === dir || path.startsWith(`${dir}/`)) : false;
          return { stdout: "", stderr: "", exitCode: exists ? 0 : 1 };
        }
        if (command.startsWith("test -f ")) {
          const match = command.match(/test -f '([^']+)'/);
          const file = match?.[1];
          return { stdout: "", stderr: "", exitCode: file && files.has(file) ? 0 : 1 };
        }
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
      },
      gitCheckout: async (_repoUrl: string, options?: { targetDir?: string }) => {
        const targetDir = options?.targetDir ?? "/workspace/blob";
        files.set(`${targetDir}/.git/HEAD`, "ref: refs/heads/main\n");
        return { success: true, targetDir };
      },
      setEnvVars: async (_envVars: Record<string, string | undefined>) => {},
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
      exists: async (path: string) => ({ exists: files.has(path) }),
      renameFile: async (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
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

  await writeTool("src/new.txt", "content", env, { sandboxId: "s1" });
  assert.equal(files.get("/workspace/blob/src/new.txt"), "content");

  await assert.rejects(() => readTool("../secrets", env, { sandboxId: "s1" }));
});

test("appendWorkspaceState creates the blob_state directory before writing", async () => {
  __resetSandboxSessionsForTests();
  const files = new Map<string, string>();
  const dirs = new Set(["/workspace"]);
  const { env } = makeEnv({
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("mkdir -p ")) {
          const match = command.match(/mkdir -p '([^']+)'/);
          if (match?.[1]) {
            dirs.add(match[1]);
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
      writeFile: async (path: string, content: string) => {
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (!dirs.has(parent)) {
          throw new Error("ENOENT");
        }
        files.set(path, content);
      },
    },
  });

  await appendWorkspaceState("context", "{\"role\":\"assistant\",\"content\":\"ok\"}", env, "state-1");

  assert.equal(files.get("/workspace/blob_state/context.jsonl"), "{\"role\":\"assistant\",\"content\":\"ok\"}\n");
});

test("sandbox idle teardown removes expired sessions", async () => {
  __resetSandboxSessionsForTests();
  const { env } = makeEnv({ SANDBOX_IDLE_TIMEOUT_MS: "0" });
  await writeTool("src/idle.txt", "x", env, { sandboxId: "idle-session" });
  const removed = await teardownIdleSandboxes(env, Date.now() + 1);
  assert.deepEqual(removed, ["idle-session"]);
});

test("sandbox cleanup keeps failed sessions when configured", async () => {
  __resetSandboxSessionsForTests();
  const { env } = makeEnv({ SANDBOX_KEEP_ON_FAILURE: "true" });
  await writeTool("src/fail.txt", "x", env, { sandboxId: "fail-session" });
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
              ...(calls === 1
                ? { content: "", tool_calls: [{ function: { name: "bash", arguments: "{\"command\":\"echo hi\"}" } }] }
                : { content: "final" }),
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
  assert.ok(progress.length >= 1);
  globalThis.fetch = originalFetch;
});

test("agent pauses after consecutive tool failures", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const { env } = makeEnv({ MAX_CONSECUTIVE_TOOL_FAILURES: "1" });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "read", arguments: "{\"path\":\"missing.txt\"}" } }] } }],
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

test("normalizeToolPath strips /workspace/blob/ prefix", () => {
  const { normalizeToolPath } = __sandboxTestUtils;
  assert.equal(normalizeToolPath("/workspace/blob/src/a.txt", "/workspace/blob"), "src/a.txt");
  assert.equal(normalizeToolPath("src/a.txt", "/workspace/blob"), "src/a.txt");
  assert.equal(normalizeToolPath("./src/a.txt", "/workspace/blob"), "src/a.txt");
});

test("normalizeToolPath rejects traversal and outside-workspace absolute paths", () => {
  const { normalizeToolPath } = __sandboxTestUtils;
  assert.throws(() => normalizeToolPath("", "/workspace/blob"), /Path not allowed/);
  assert.throws(() => normalizeToolPath("/etc/passwd", "/workspace/blob"), /Path not allowed/);
  assert.throws(() => normalizeToolPath("../secrets", "/workspace/blob"), /Path not allowed/);
  assert.throws(() => normalizeToolPath("/workspace/blob/../secrets", "/workspace/blob"), /Path not allowed/);
});



test("sandbox tools honor custom workspace roots", async () => {
  __resetSandboxSessionsForTests();
  const { env, files } = makeEnv();
  files.set("/workspace/demo/src/a.txt", "demo repo");

  const content = await readTool("/workspace/demo/src/a.txt", env, { sandboxId: "s4", workspaceRoot: "/workspace/demo" });
  assert.equal(content, "demo repo");

  await writeTool("src/new.txt", "from-demo", env, { sandboxId: "s4", workspaceRoot: "/workspace/demo" });
  assert.equal(files.get("/workspace/demo/src/new.txt"), "from-demo");
  await assert.rejects(() => readTool("/workspace/blob/src/a.txt", env, { sandboxId: "s4", workspaceRoot: "/workspace/demo" }));
});

test("readTool accepts absolute workspace paths", async () => {
  __resetSandboxSessionsForTests();
  const { env } = makeEnv();
  const content = await readTool("/workspace/blob/src/a.txt", env, { sandboxId: "s2" });
  assert.equal(content, "hello world");
});

test("writeTool accepts absolute workspace paths", async () => {
  __resetSandboxSessionsForTests();
  const { env, files } = makeEnv();
  await writeTool("/workspace/blob/src/abs.txt", "absolute", env, { sandboxId: "s3" });
  assert.equal(files.get("/workspace/blob/src/abs.txt"), "absolute");
});


test("agent tools use repo-specific workspace root", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const execCalls: Array<{ command: string; options?: { cwd?: string } }> = [];
  const { env } = makeEnv({
    SANDBOX: {
      start: async () => {},
      exec: async (command: string, options?: { cwd?: string }) => {
        execCalls.push({ command, options });
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      gitCheckout: async () => ({ success: true, targetDir: "/workspace/project" }),
      setEnvVars: async () => {},
      writeFile: async (_path: string, _content: string) => {},
      readFile: async (path: string) => path.includes("/workspace/project/src/a.txt") ? "ok" : Promise.reject(new Error("ENOENT")),
      exists: async () => ({ exists: false }),
      renameFile: async () => {},
    },
    AI_GATEWAY_BASE_URL: "https://gateway.example",
  });

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: calls === 1 ? { content: '', tool_calls: [{ function: { name: 'read', arguments: '{\"path\":\"src/a.txt\"}' } }] } : calls === 2 ? { content: '', tool_calls: [{ function: { name: 'bash', arguments: '{\"command\":\"pwd\"}' } }] } : { content: 'done' } }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const agent = new PiAgent(env, "owner/project");
    const result = await agent.run("test", { sandboxId: "repo-root" });
    assert.equal(result, "done");
    assert.ok(execCalls.some(({ command, options }) => command === "pwd" && options?.cwd === "/workspace/project"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bootstrap uses native git checkout and skips repo cache shuffling", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const execCommands: string[] = [];
  const gitCheckouts: Array<{ repoUrl: string; options?: { targetDir?: string; sessionId?: string; env?: Record<string, string | undefined> } }> = [];
  let hasRepo = false;

  const { env } = makeEnv({
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        execCommands.push(command);
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: hasRepo ? 0 : 1 };
        }
        if (command.startsWith("test -f ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      gitCheckout: async (
        repoUrl: string,
        options?: { targetDir?: string; sessionId?: string; env?: Record<string, string | undefined> },
      ) => {
        gitCheckouts.push({ repoUrl, options });
        hasRepo = true;
        return { success: true, targetDir: options?.targetDir };
      },
      setEnvVars: async () => {},
      writeFile: async (_path: string, _content: string) => {},
      readFile: async (_path: string) => "ok",
      exists: async () => ({ exists: false }),
      renameFile: async () => {},
    },
    GITHUB_TOKEN: "ghs_test_token",
  });

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const message =
      calls === 1
        ? { content: '', tool_calls: [{ function: { name: 'read', arguments: '{\"path\":\"README.md\"}' } }] }
        : { content: "done" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const agent = new PiAgent(env, "owner/project");
    const result = await agent.run("test", { sandboxId: "cache-hit" });
    assert.equal(result, "done");
    assert.deepEqual(gitCheckouts, [{
      repoUrl: "https://github.com/owner/project.git",
      options: {
        sessionId: "cache-hit",
        targetDir: "/workspace/project",
        depth: 1,
        env: {
          GITHUB_TOKEN: "ghs_test_token",
          GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    }]);
    assert.ok(execCommands.some((command) => command.includes("git fetch --depth=1 --prune origin")));
    assert.ok(execCommands.every((command) => !command.includes("/tmp/project.repo-cache.part.")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent bootstraps once before first tool call", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const execCommands: string[] = [];
  const gitCheckouts: Array<{ repoUrl: string; options?: { targetDir?: string; sessionId?: string; env?: Record<string, string | undefined> } }> = [];
  let hasRepo = false;

  const { env } = makeEnv({
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        execCommands.push(command);
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: hasRepo ? 0 : 1 };
        }
        if (command.startsWith("test -f ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      gitCheckout: async (
        repoUrl: string,
        options?: { targetDir?: string; sessionId?: string; env?: Record<string, string | undefined> },
      ) => {
        gitCheckouts.push({ repoUrl, options });
        hasRepo = true;
        return { success: true, targetDir: options?.targetDir };
      },
      setEnvVars: async () => {},
      writeFile: async (_path: string, _content: string) => {},
      readFile: async (_path: string) => "ok",
      exists: async () => ({ exists: false }),
      renameFile: async () => {},
    },
    GITHUB_TOKEN: "ghs_test_token",
  });

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const message =
      calls === 1
        ? { content: '', tool_calls: [{ function: { name: 'read', arguments: '{\"path\":\"README.md\"}' } }] }
        : calls === 2
          ? { content: '', tool_calls: [{ function: { name: 'bash', arguments: '{\"command\":\"pwd\"}' } }] }
          : { content: "done" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const agent = new PiAgent(env, "owner/project");
    const result = await agent.run("test", { sandboxId: "bootstrap-1" });
    assert.equal(result, "done");
    assert.deepEqual(gitCheckouts, [{
      repoUrl: "https://github.com/owner/project.git",
      options: {
        sessionId: "bootstrap-1",
        targetDir: "/workspace/project",
        depth: 1,
        env: {
          GITHUB_TOKEN: "ghs_test_token",
          GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    }]);
    assert.ok(execCommands.some((command) => command.includes("git fetch --depth=1 --prune origin")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent reports bootstrap failures with error text", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  const { env } = makeEnv({
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (command.startsWith("test -f ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      gitCheckout: async () => {
        throw new Error("fatal: repo not found");
      },
      setEnvVars: async () => {},
      writeFile: async (_path: string, _content: string) => {},
      readFile: async (_path: string) => "ok",
      exists: async () => ({ exists: false }),
      renameFile: async () => {},
    },
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'read', arguments: '{\"path\":\"README.md\"}' } }] } }] }), {
      status: 200,
    })) as typeof fetch;

  try {
    const agent = new PiAgent(env, "owner/project");
    const result = await agent.run("test", { sandboxId: "bootstrap-fail", verbosity: "verbose" });
    assert.match(result, /Bootstrap failed:/);
    assert.match(result, /repo bootstrap failed/);
    assert.match(result, /fatal: repo not found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runSelfTest executes tool and memory sequence", async () => {
  __resetSandboxSessionsForTests();
  const execCalls: Array<{ command: string; options?: { cwd?: string } }> = [];
  const files = new Map<string, string>();
  const r2 = new Map<string, string>();
  const vectors = new Map<string, { id: string; metadata?: Record<string, unknown> }>();

  const env = {
    SANDBOX: {
      start: async () => {},
      exec: async (command: string, options?: { cwd?: string }) => {
        execCalls.push({ command, options });
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
        }
        if (command.includes("node -v")) {
          return { stdout: "v20.11.1\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      gitCheckout: async (_repoUrl: string, options?: { targetDir?: string }) => {
        files.set(`${options?.targetDir ?? "/workspace/project"}/.git/HEAD`, "ref: refs/heads/main\n");
        return { success: true, targetDir: options?.targetDir };
      },
      setEnvVars: async () => {},
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
      exists: async (path: string) => ({ exists: files.has(path) }),
      renameFile: async (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
      },
    },
    REPO_STORE: {
      put: async (key: string, val: string) => {
        r2.set(key, val);
      },
      get: async (key: string) => {
        const val = r2.get(key);
        return val === undefined ? null : { text: async () => val };
      },
    },
    PI_VECTORS: {
      upsert: async (rows: Array<{ id: string; metadata?: Record<string, unknown> }>) => {
        for (const row of rows) vectors.set(row.id, row);
      },
      getByIds: async (ids: string[]) => {
        return ids.flatMap((id) => {
          const row = vectors.get(id);
          return row ? [row] : [];
        });
      },
    },
    AI: {
      run: async () => ({ data: [[0.1, 0.2]] }),
    },
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
      }),
    },
  } as any;

  const progress: string[] = [];
  const agent = new PiAgent(env, "owner/project");
  const result = await agent.runSelfTest({ sandboxId: "st-1", verbosity: "verbose", onProgress: (line) => progress.push(line), conversationKey: "T1:C1:channel" });

  assert.match(result, /Self-test passed/i);
  assert.ok(progress.some((line) => line.includes("using repo workspace at /workspace/project")));
  assert.ok(progress.some((line) => line.includes("read")));
  assert.ok(progress.some((line) => line.includes("vectorize")));
  assert.ok(execCalls.some(({ command, options }) => command === "node -v" && options?.cwd === "/workspace/project"));
  assert.equal(files.get("/workspace/project/.blob/selftest.txt")?.includes("edited"), true);
});


test("runSelfTest skips vectorize when binding is not configured", async () => {
  __resetSandboxSessionsForTests();
  const files = new Map<string, string>();
  const r2 = new Map<string, string>();

  const env = {
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (command.startsWith("test -f ")) {
          const match = command.match(/test -f '([^']+)'/);
          const file = match?.[1];
          return { stdout: "", stderr: "", exitCode: file && files.has(file) ? 0 : 1 };
        }
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
        }
        if (command.includes("node -v")) {
          return { stdout: "v20.11.1\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      gitCheckout: async (_repoUrl: string, options?: { targetDir?: string }) => {
        files.set(`${options?.targetDir ?? "/workspace/project"}/.git/HEAD`, "ref: refs/heads/main\n");
        return { success: true, targetDir: options?.targetDir };
      },
      setEnvVars: async () => {},
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
      exists: async (path: string) => ({ exists: files.has(path) }),
      renameFile: async (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
      },
    },
    REPO_STORE: {
      put: async (key: string, val: string) => {
        r2.set(key, val);
      },
      get: async (key: string) => {
        const val = r2.get(key);
        return val === undefined ? null : { text: async () => val };
      },
    },
    AI: {
      run: async () => ({ data: [[0.1, 0.2]] }),
    },
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
      }),
    },
  } as any;

  const result = await new PiAgent(env, "owner/project").runSelfTest({
    sandboxId: "st-no-vector",
    verbosity: "verbose",
    conversationKey: "T1:C1:channel",
  });

  assert.match(result, /Self-test passed/i);
  assert.match(result, /vectorize: skipped \(PI_VECTORS binding missing/);
});

test("runSelfTest verifies vectorize upsert without requiring synchronous readback", async () => {
  __resetSandboxSessionsForTests();
  const files = new Map<string, string>();
  const r2 = new Map<string, string>();
  const vectors = new Map<string, { id: string; metadata?: Record<string, unknown>; values?: number[] }>();

  const env = {
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("test -d ")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (command.startsWith("test -f ")) {
          const match = command.match(/test -f '([^']+)'/);
          const file = match?.[1];
          return { stdout: "", stderr: "", exitCode: file && files.has(file) ? 0 : 1 };
        }
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
        }
        if (command.includes("node -v")) {
          return { stdout: "v20.11.1\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      gitCheckout: async (_repoUrl: string, options?: { targetDir?: string }) => {
        files.set(`${options?.targetDir ?? "/workspace/project"}/.git/HEAD`, "ref: refs/heads/main\n");
        return { success: true, targetDir: options?.targetDir };
      },
      setEnvVars: async () => {},
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path) ?? "";
      },
      exists: async (path: string) => ({ exists: files.has(path) }),
      renameFile: async (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
      },
    },
    REPO_STORE: {
      put: async (key: string, val: string) => {
        r2.set(key, val);
      },
      get: async (key: string) => {
        const val = r2.get(key);
        return val === undefined ? null : { text: async () => val };
      },
    },
    PI_VECTORS: {
      upsert: async (rows: Array<{ id: string; metadata?: Record<string, unknown>; values?: number[] }>) => {
        for (const row of rows) vectors.set(row.id, row);
      },
    },
    AI: {
      run: async () => ({ data: [[0.9, 0.8]] }),
    },
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
      }),
    },
    SELFTEST_VECTORIZE_QUERY_RETRY_MS: "5",
    SELFTEST_VECTORIZE_QUERY_TIMEOUT_MS: "1000",
  } as any;

  const result = await new PiAgent(env, "owner/project").runSelfTest({
    sandboxId: "st-vector-retry",
    verbosity: "verbose",
    conversationKey: "T1:C1:channel",
  });

  assert.match(result, /Self-test passed/i);
  assert.equal(vectors.size, 1);
  const [stored] = [...vectors.values()];
  assert.equal(stored.metadata?.conversationKey, "T1:C1:channel");
});
