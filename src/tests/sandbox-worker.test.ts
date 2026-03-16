import test from "node:test";
import assert from "node:assert/strict";
import { isRecoverableSandboxError, resetSandboxStartedState, runSandboxOperation } from "../integrations/sandbox-retry";
import { classifyCommandKind, summarizePath } from "../integrations/sandbox-observability";

test("isRecoverableSandboxError detects shell/session restart errors", () => {
  assert.equal(isRecoverableSandboxError(new Error("Session 'sandbox-agent' is not ready or shell has died")), true);
  assert.equal(isRecoverableSandboxError(new Error("withSession callback failed for session 'sandbox-agent'")), true);
  assert.equal(isRecoverableSandboxError(new Error("ENOENT")), false);
});

test("runSandboxOperation retries once on recoverable error", async () => {
  resetSandboxStartedState();
  let starts = 0;
  let calls = 0;
  const sandbox = {
    start: async () => { starts += 1; },
  } as unknown as Parameters<typeof runSandboxOperation>[0];

  const result = await runSandboxOperation(sandbox, async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("withSession callback failed for session 'sandbox-agent': Session 'sandbox-agent' is not ready or shell has died");
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(starts, 2);
});

test("runSandboxOperation does not retry non-recoverable errors", async () => {
  resetSandboxStartedState();
  let starts = 0;
  let calls = 0;
  const sandbox = {
    start: async () => { starts += 1; },
  } as unknown as Parameters<typeof runSandboxOperation>[0];

  await assert.rejects(
    runSandboxOperation(sandbox, async () => {
      calls += 1;
      throw new Error("permission denied");
    }),
    /permission denied/
  );

  assert.equal(calls, 1);
  assert.equal(starts, 1);
});

test("sandbox worker classifies command kind without logging raw command text", () => {
  assert.equal(classifyCommandKind("cd /workspace/blob && git status"), "git");
  assert.equal(classifyCommandKind("export TOKEN=secret; curl https://example.com"), "curl");
  assert.equal(classifyCommandKind("echo hello"), "custom");
});

test("sandbox worker summarizes long paths while preserving both ends", () => {
  const longPath = "/workspace/blob/" + "deep/".repeat(30) + "target.txt";
  const summarized = summarizePath(longPath, 40);
  assert.match(summarized, /^\/workspace\/blob/);
  assert.match(summarized, /target\.txt$/);
  assert.ok(summarized.includes("…"));
  assert.ok(summarized.length <= 40);
});
