import test from "node:test";
import assert from "node:assert/strict";
import { PiAgent, __piAgentTestUtils } from "../agent/pi-agent";
import type { Env } from "../core/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AGENT_DO: {} as DurableObjectNamespace,
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

test("fallback parser handles TOOL/ARG format", () => {
  const call = __piAgentTestUtils.parseToolCall('TOOL: edit\nARG: {"path":"a.ts","oldText":"x","newText":"y"}');
  assert.deepEqual(call, {
    tool: "edit",
    args: { path: "a.ts", oldText: "x", newText: "y" },
  });
});

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
