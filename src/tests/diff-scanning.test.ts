import test from "node:test";
import assert from "node:assert/strict";

import { scanDiffForSecrets } from "../integrations/github";

test("scanDiffForSecrets blocks added secret line", () => {
  const diff = `+api_key=supersecretvalue12345`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, true);
  assert.equal(result.matches.length, 1);
});

test("scanDiffForSecrets ignores removed secret lines", () => {
  const diff = `-api_key=supersecretvalue12345`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.matches, []);
});

test("scanDiffForSecrets blocks context lines with secrets", () => {
  const diff = ` api_key=supersecretvalue12345`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, true);
});

test("scanDiffForSecrets blocks whitespace-only reformats that still contain token", () => {
  const diff = `+  token = ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, true);
});

test("scanDiffForSecrets passes clean diffs", () => {
  const diff = `+const answer = 42\n context line`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.matches, []);
});

test("scanDiffForSecrets does not match partial token split across lines", () => {
  const diff = `+token=abcde\n+12345`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, false);
});
