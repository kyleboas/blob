import test from "node:test";
import assert from "node:assert/strict";
import { PiAgent, __piAgentTestUtils } from "../agent/pi-agent";
import { __resetSandboxSessionsForTests } from "../integrations/sandbox";
import type { Env } from "../core/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
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

  return {
    AGENT_DO: {
      idFromName: () => "blob" as DurableObjectId,
      get: () => doStub,
    } as DurableObjectNamespace,
    SANDBOX: {
      start: async () => undefined,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => undefined,
    },
    REPO_STORE: {
      get: async () => null,
      put: async () => undefined,
      list: async () => ({ objects: [] }),
      delete: async () => undefined,
    } as unknown as R2Bucket,
    ...overrides,
  } as Env;
}

test("structured tool-call parser handles valid and invalid payloads", () => {
  const valid = __piAgentTestUtils.parseStructuredToolCall({
    function: { name: "bash", arguments: '{"command":"node -v"}' },
  });
  assert.deepEqual(valid, { tool: "bash", args: { command: "node -v" } });

  const invalid = __piAgentTestUtils.parseStructuredToolCall({
    function: { name: "unknown", arguments: "{}" },
  });
  assert.equal(invalid, null);
});


test("callLLM appends current UTC date/time to tool-enabled model calls", async () => {
  const env = makeEnv({
    AI_GATEWAY_BASE_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "x",
  });
  const agent = new PiAgent(env, "acme/repo");

  const originalFetch = globalThis.fetch;
  let capturedMessages: Array<{ role: string; content: string }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    capturedMessages = body.messages ?? [];
    return new Response(JSON.stringify({ choices: [{ message: { content: "Done.", tool_calls: [] } }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const response = await (agent as any).callLLM();
    assert.equal(response.content, "Done.");
    const currentTimeMessage = capturedMessages[capturedMessages.length - 1];
    assert.equal(currentTimeMessage?.role, "system");
    assert.match(currentTimeMessage?.content ?? "", /^Current date\/time \(UTC\): [^\s]+\. Treat this as the authoritative current timestamp for time-sensitive requests\.$/);

    const isoTimestamp = (currentTimeMessage?.content ?? "").replace(/^Current date\/time \(UTC\): /, "").replace(/\. Treat this as the authoritative current timestamp for time-sensitive requests\.$/, "");
    assert.equal(Number.isNaN(Date.parse(isoTimestamp)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("tool-avoidance claim detector catches no-access language", () => {
  assert.equal(__piAgentTestUtils.containsToolAvoidanceClaim("I don't have access to real-time weather data."), true);
  assert.equal(__piAgentTestUtils.containsToolAvoidanceClaim("I cannot access that right now."), true);
  assert.equal(__piAgentTestUtils.containsToolAvoidanceClaim("Here is the result."), false);
});

test("agent prompts for tool usage when classifier flags external-data-only sandbox need", async () => {
  const env = makeEnv();
  const agent = new PiAgent(env, "acme/repo");

  let callCount = 0;
  (agent as any).callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return { content: "Here is my best guess.", toolCalls: [] };
    }
    if (callCount === 2) {
      return { content: "", toolCalls: [{ function: { name: "bash", arguments: '{"command":"echo live-data"}' } }] };
    }
    return { content: "Fetched live-data.", toolCalls: [] };
  };

  (agent as any).shouldForceExternalToolForMessage = async () => true;
  (agent as any).ensureRepoBootstrapped = async () => undefined;
  (agent as any).executeToolWithRetry = async () => ({ output: "live-data" });

  const result = await agent.run("give me latest exchange rate");

  assert.equal(result, "Fetched live-data.");
  assert.equal(callCount, 3);
});

test("agent prompts for tool usage when model claims no access on uncovered topic", async () => {
  const env = makeEnv();
  const agent = new PiAgent(env, "acme/repo");

  let callCount = 0;
  (agent as any).callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return { content: "I don't have access to real-time exchange-rate data.", toolCalls: [] };
    }
    if (callCount === 2) {
      return { content: "", toolCalls: [{ function: { name: "bash", arguments: '{"command":"echo 0.92"}' } }] };
    }
    return { content: "USD/EUR is 0.92.", toolCalls: [] };
  };

  (agent as any).ensureRepoBootstrapped = async () => undefined;
  (agent as any).executeToolWithRetry = async () => ({ output: "0.92" });

  const result = await agent.run("exchange rate usd eur");

  assert.equal(result, "USD/EUR is 0.92.");
  assert.equal(callCount, 3);
});

test("agent prompts for tool usage when external data request gets no tool call", async () => {
  const env = makeEnv();
  const agent = new PiAgent(env, "acme/repo");

  let callCount = 0;
  (agent as any).callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return { content: "I don't have access to real-time weather data.", toolCalls: [] };
    }
    if (callCount === 2) {
      return { content: "", toolCalls: [{ function: { name: "bash", arguments: '{"command":"echo sunny"}' } }] };
    }
    return { content: "It is sunny.", toolCalls: [] };
  };

  (agent as any).ensureRepoBootstrapped = async () => undefined;
  (agent as any).executeToolWithRetry = async () => ({ output: "sunny" });

  const result = await agent.run("what is the weather in london right now");

  assert.equal(result, "It is sunny.");
  assert.equal(callCount, 3);
});
test("agent run executes structured tool calls and emits tool ledger entries", async () => {
  const env = makeEnv();
  const agent = new PiAgent(env, "acme/repo");

  let callCount = 0;
  (agent as any).callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        content: "",
        toolCalls: [{ function: { name: "read", arguments: '{"path":"README.md"}' } }],
      };
    }
    return { content: "Done.", toolCalls: [] };
  };

  (agent as any).ensureRepoBootstrapped = async () => undefined;
  (agent as any).executeToolWithRetry = async () => ({ output: "# test" });

  const ledgers: Array<{ tool: string; argsSummary: string; ok: boolean; durationMs: number; error?: string }> = [];
  const result = await agent.run("readme", {
    onToolLedger: (entry) => {
      ledgers.push(entry);
    },
  });

  assert.equal(result, "Done.");
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].tool, "read");
  assert.equal(ledgers[0].ok, true);
  assert.match(ledgers[0].argsSummary, /path=README\.md/);
});

test("verification loop re-enters agent when VERIFY_COMMAND fails", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  let verifyCallCount = 0;
  let llmCallCount = 0;

  const env = makeEnv({
    VERIFY_COMMAND: "npm test",
    VERIFY_MAX_ATTEMPTS: "2",
    AI_GATEWAY_BASE_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "x",
    SANDBOX: {
      start: async () => undefined,
      exec: async (command: string) => {
        if (command.includes("npm test")) {
          verifyCallCount += 1;
          if (verifyCallCount === 1) {
            return { stdout: "", stderr: "Error: test failed\nassert.equal failed", exitCode: 1 };
          }
          return { stdout: "All tests passed", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => "",
      writeFile: async () => undefined,
    },
  });

  globalThis.fetch = (async () => {
    llmCallCount += 1;
    if (llmCallCount === 1) {
      // First call: agent does some work
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "bash", arguments: '{"command":"echo fix"}' } }] } }],
      }), { status: 200 });
    }
    // Subsequent calls: agent says it's done
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Fixed the issue." } }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const progress: string[] = [];
    const agent = new PiAgent(env, "blob");
    (agent as any).shouldForceExternalToolForMessage = async () => false;
    const result = await agent.run("fix tests", {
      sandboxId: "verify-1",
      verbosity: "verbose",
      onProgress: (msg) => progress.push(msg),
    });

    // Verify that verification was run twice (first fail, then pass)
    assert.equal(verifyCallCount, 2);
    // Model was called 3 times: tool call, "done" (verify fails), "done" again (verify passes)
    assert.equal(llmCallCount, 3);
    assert.equal(result, "Fixed the issue.");
    assert.ok(progress.some((p) => p.includes("Verification failed")));
    assert.ok(progress.some((p) => p.includes("Verification passed")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verification skipped when VERIFY_COMMAND is not set", async () => {
  const env = makeEnv();
  const agent = new PiAgent(env, "acme/repo");

  let callCount = 0;
  (agent as any).callLLM = async () => {
    callCount += 1;
    return { content: "All done.", toolCalls: [] };
  };
  // Mock the intent classifier so it doesn't make its own LLM call
  (agent as any).shouldForceExternalToolForMessage = async () => false;

  const result = await agent.run("hello");
  assert.equal(result, "All done.");
  assert.equal(callCount, 1);
});

test("verification auto-detects repo test command when VERIFY_COMMAND is not set", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  let verifyCallCount = 0;
  let llmCallCount = 0;

  const env = makeEnv({
    AI_GATEWAY_BASE_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "x",
    SANDBOX: {
      start: async () => undefined,
      exec: async (command: string) => {
        if (command.includes("# blob-detect-verify-command")) {
          return { stdout: "npm run test\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("npm run test")) {
          verifyCallCount += 1;
          return { stdout: "All tests passed", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => "",
      writeFile: async () => undefined,
    },
  });

  globalThis.fetch = (async () => {
    llmCallCount += 1;
    if (llmCallCount === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "bash", arguments: '{"command":"echo fix"}' } }] } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Fixed and verified." } }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const agent = new PiAgent(env, "blob");
    (agent as any).shouldForceExternalToolForMessage = async () => false;
    const result = await agent.run("fix it", { sandboxId: "auto-detect-verify" });

    assert.equal(verifyCallCount, 1);
    assert.equal(result, "Fixed and verified.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verification stops retrying after max attempts", async () => {
  __resetSandboxSessionsForTests();
  const originalFetch = globalThis.fetch;
  let verifyCallCount = 0;
  let llmCallCount = 0;

  const env = makeEnv({
    VERIFY_COMMAND: "npm test",
    VERIFY_MAX_ATTEMPTS: "2",
    AI_GATEWAY_BASE_URL: "https://gateway.example",
    AI_GATEWAY_TOKEN: "x",
    SANDBOX: {
      start: async () => undefined,
      exec: async (command: string) => {
        if (command.includes("npm test")) {
          verifyCallCount += 1;
          return { stdout: "", stderr: "Error: still broken", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => "",
      writeFile: async () => undefined,
    },
  });

  globalThis.fetch = (async () => {
    llmCallCount += 1;
    if (llmCallCount === 1) {
      // First call: agent does a tool call so bootstrap happens
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "bash", arguments: '{"command":"echo fix"}' } }] } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "I think it's fixed now." } }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const agent = new PiAgent(env, "blob");
    (agent as any).shouldForceExternalToolForMessage = async () => false;
    const result = await agent.run("fix it", { sandboxId: "verify-max" });

    // After 2 failed verify attempts, the 3rd "done" goes through without verify
    assert.equal(verifyCallCount, 2);
    // 1 tool call + 2 "done" (verify fails) + 1 "done" (verify skipped at max)
    assert.equal(llmCallCount, 4);
    assert.equal(result, "I think it's fixed now.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
