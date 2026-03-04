import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition, shouldForcePause } from "../job-model";

test("job lifecycle transition rules", () => {
  assert.equal(canTransition("queued", "running"), true);
  assert.equal(canTransition("queued", "completed"), false);
  assert.equal(canTransition("running", "paused"), true);
  assert.equal(canTransition("paused", "running"), true);
  assert.equal(canTransition("failed", "running"), false);
});

test("assertTransition throws on invalid transitions", () => {
  assert.throws(() => assertTransition("queued", "completed"));
});

test("shouldForcePause enforces maximum job duration", () => {
  const createdAt = Date.now() - 31 * 60 * 1000;
  assert.equal(shouldForcePause(createdAt, Date.now(), 30 * 60 * 1000), true);
});
