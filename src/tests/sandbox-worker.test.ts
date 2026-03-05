import test from "node:test";
import assert from "node:assert/strict";
import { isRecoverableSandboxError, runSandboxOperation } from "../integrations/sandbox-retry";

test("isRecoverableSandboxError detects shell/session restart errors", () => {
  assert.equal(isRecoverableSandboxError(new Error("Session 'sandbox-agent' is not ready or shell has died")), true);
  assert.equal(isRecoverableSandboxError(new Error("withSession callback failed for session 'sandbox-agent'")), true);
  assert.equal(isRecoverableSandboxError(new Error("ENOENT")), false);
});

test("runSandboxOperation retries once on recoverable error", async () => {
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
