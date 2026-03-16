import test from "node:test";
import assert from "node:assert/strict";
import worker from "../index";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const files = new Map<string, string>();
  const r2 = new Map<string, string>();
  const vectors = new Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>();

  const env = {
    DO_AUTH_SECRET: "shared-secret",
    AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string) => {
          if (url === "http://do/repos") {
            return Response.json({ repos: ["owner/blob"] });
          }
          return Response.json({ ok: true });
        },
      }),
    },
    SANDBOX: {
      start: async () => {},
      exec: async (command: string) => {
        if (command.startsWith("mv ")) {
          const [, from, to] = command.split(" ");
          files.set(to, files.get(from) ?? "");
          files.delete(from);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command.includes("node -v")) {
          return { stdout: "v20.11.1\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readFile: async (path: string) => files.get(path) ?? "",
    },
    AI: {
      run: async (_model: string, inputs: { text?: string | string[] }) => {
        if (inputs.text) {
          return { data: [[0.1, 0.2, 0.3]] };
        }
        return { response: "" };
      },
    },
    PI_VECTORS: {
      query: async () => ({
        matches: [...vectors.values()].slice(0, 1).map((row) => ({
          id: row.id,
          score: 0.99,
          metadata: row.metadata,
        })),
      }),
      upsert: async (rows: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => {
        for (const row of rows) vectors.set(row.id, row);
      },
      deleteByIds: async () => undefined,
      insert: async () => undefined,
      getByIds: async (ids: string[]) => ids.flatMap((id) => {
        const row = vectors.get(id);
        return row ? [row] : [];
      }),
      describe: async () => ({ dimensions: 3, count: 0, metric: "cosine" }),
    },
    REPO_STORE: {
      put: async (key: string, value: string) => {
        r2.set(key, value);
      },
      get: async (key: string) => {
        const value = r2.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      head: async () => null,
    },
    ...overrides,
  } as any;

  return env;
}

test("admin selftest rejects unauthorized requests", async () => {
  const res = await worker.fetch(new Request("https://example.com/admin/selftest", { method: "POST" }), makeEnv(), {} as any);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: "Unauthorized." });
});

test("admin selftest runs with bearer auth", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://example.com/admin/selftest", {
    method: "POST",
    headers: { authorization: "Bearer shared-secret" },
  }), env, {} as any);

  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; passed: boolean; repo: string; message: string };
  assert.equal(body.ok, true);
  assert.equal(body.passed, true);
  assert.equal(body.repo, "owner/blob");
  assert.match(body.message, /Self-test passed/i);
  assert.match(body.message, /sandbox tools and R2 are healthy/i);
});

test("health reports all critical production dependencies", async () => {
  const res = await worker.fetch(new Request("https://example.com/health"), makeEnv(), {} as any);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: "healthy",
    checks: {
      r2: true,
      sandbox: true,
      vectorize: true,
      do: true,
    },
  });
});

test("health degrades when vectorize is unavailable", async () => {
  const res = await worker.fetch(new Request("https://example.com/health"), makeEnv({ PI_VECTORS: undefined }), {} as any);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: "degraded",
    checks: {
      r2: true,
      sandbox: true,
      vectorize: false,
      do: true,
    },
  });
});
