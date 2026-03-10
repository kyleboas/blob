import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "../core/safety";
import { routeRequest, type RouterCtx } from "../agent/do-router";
import type { BlobState } from "../agent/do";
import type { Env } from "../core/types";

function createRouterCtx(): RouterCtx {
  const data: BlobState = {
    repos: [],
    goals: {},
    messages: [],
    userPreferences: {},
    processedEvents: [],
  };

  return {
    state: {
      storage: {
        sql: { exec: () => ({ toArray: () => [], one: () => null }) },
        getAlarm: async () => null,
      },
    } as unknown as DurableObjectState,
    env: {} as Env,
    data,
    save: async () => undefined,
  };
}

test("redactSecrets redacts plain api key assignment", () => {
  const input = "api_key=secretsecretsecret";
  assert.equal(redactSecrets(input), "[REDACTED]");
});

test("redactSecrets redacts URL-embedded github token", () => {
  const input = "git clone https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/acme/repo.git";
  const output = redactSecrets(input);
  assert.equal(output.includes("x-access-token"), false);
  assert.equal(output.includes("[REDACTED]"), true);
});

test("redactSecrets redacts long base64 token assignments", () => {
  const input = "authorization=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MCsvPT0=";
  assert.equal(redactSecrets(input), "[REDACTED]");
});

test("redactSecrets handles multi-line secrets and private key blocks", () => {
  const input = [
    "line one",
    "password=supersecret123",
    "-----BEGIN PRIVATE KEY-----",
    "abc123",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  const output = redactSecrets(input);
  assert.equal(output.includes("supersecret123"), false);
  assert.equal(output.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(output.includes("[REDACTED]"), true);
});

test("redactSecrets does not match token split across newline", () => {
  const input = "token=abcde\n12345";
  assert.equal(redactSecrets(input), input);
});

test("redactSecrets handles empty and clean input", () => {
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets("hello world"), "hello world");
});

test("DO router no longer exposes legacy secrets values endpoint", async () => {
  const ctx = createRouterCtx();
  const legacyPath = ["/secrets", "values"].join("/");
  const response = await routeRequest(
    new URL(`https://example.com${legacyPath}`),
    "GET",
    new Request(`https://example.com${legacyPath}`, { method: "GET" }),
    ctx,
  );

  assert.equal(response.status, 404);
});
