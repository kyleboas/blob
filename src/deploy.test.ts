import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeployIdempotencyKey,
  buildDeployTriggerRequest,
  formatDeploySlackMessage,
  pollDeployStatus,
  triggerDeploy,
} from "./deploy";

test("buildDeployIdempotencyKey is merge-sha based", () => {
  assert.equal(buildDeployIdempotencyKey("abc123"), "deploy:abc123");
});

test("buildDeployTriggerRequest creates webhook payload", () => {
  const req = buildDeployTriggerRequest({ type: "webhook", url: "https://example.com/hook" }, "abc123");
  assert.ok(req);
  assert.equal(req?.url, "https://example.com/hook");
  const headers = new Headers(req?.init.headers);
  assert.equal(headers.get("x-idempotency-key"), "deploy:abc123");
});

test("triggerDeploy skips when not configured", async () => {
  const result = await triggerDeploy({ type: "none" }, "abc123");
  assert.equal(result.status, "skipped");
});

test("pollDeployStatus returns timeout when still pending", async () => {
  const status = await pollDeployStatus(async () => "pending", { timeoutMs: 25, intervalMs: 5 });
  assert.equal(status, "timeout");
});

test("formatDeploySlackMessage returns status messages", () => {
  assert.match(formatDeploySlackMessage("success"), /succeeded/);
  assert.match(formatDeploySlackMessage("timeout"), /timed out/);
});
