import test from "node:test";
import assert from "node:assert/strict";

import { __sandboxTestUtils } from "../integrations/sandbox";

const { normalizeToolPath } = __sandboxTestUtils;

const WORKSPACE = "/workspace/blob";

test("normalizeToolPath blocks traversal and absolute outside path", () => {
  assert.throws(() => normalizeToolPath("../../../etc/passwd", WORKSPACE), /Path not allowed/);
  assert.throws(() => normalizeToolPath("/etc/passwd", WORKSPACE), /Path not allowed/);
});

test("normalizeToolPath accepts valid relative paths and strips convenience prefixes", () => {
  assert.equal(normalizeToolPath("./valid/path", WORKSPACE), "valid/path");
  assert.equal(normalizeToolPath("/workspace/blob/valid/path", WORKSPACE), "valid/path");
});

test("normalizeToolPath rejects empty path and embedded traversal", () => {
  assert.throws(() => normalizeToolPath("", WORKSPACE), /Path not allowed/);
  assert.throws(() => normalizeToolPath("foo/../../bar", WORKSPACE), /Path not allowed/);
});

test("normalizeToolPath does not decode URL encoded traversal", () => {
  assert.equal(normalizeToolPath("safe/%2e%2e/path", WORKSPACE), "safe/%2e%2e/path");
});
