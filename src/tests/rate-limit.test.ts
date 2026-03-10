import test from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, clearRateLimitState, configureRateLimit } from "../integrations/slack-rate-limit";

test("sliding-window rate limiter allows up to limit and blocks limit+1", () => {
  clearRateLimitState();
  configureRateLimit({ windowMs: 60_000, maxMessages: 3 });

  const start = 1_000_000;
  assert.equal(checkRateLimit("C123", start).allowed, true);
  assert.equal(checkRateLimit("C123", start + 1000).allowed, true);
  assert.equal(checkRateLimit("C123", start + 2000).allowed, true);

  const blocked = checkRateLimit("C123", start + 3000);
  assert.equal(blocked.allowed, false);
  assert.ok((blocked.retryAfterMs ?? 0) > 0);
});

test("rate limiter allows messages again after window expires", () => {
  clearRateLimitState();
  configureRateLimit({ windowMs: 5_000, maxMessages: 2 });

  const start = 50_000;
  assert.equal(checkRateLimit("C999", start).allowed, true);
  assert.equal(checkRateLimit("C999", start + 1000).allowed, true);
  assert.equal(checkRateLimit("C999", start + 2000).allowed, false);

  const afterWindow = checkRateLimit("C999", start + 5001);
  assert.equal(afterWindow.allowed, true);
});
