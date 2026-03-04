import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, defaultPromptContext, type PromptContext } from "../prompts/system-prompt";

// ── defaultPromptContext ─────────────────────────────────────────────────────

test("defaultPromptContext returns all required fields", () => {
  const ctx = defaultPromptContext();
  assert.equal(ctx.sandboxEnabled, true);
  assert.equal(ctx.timezone, "UTC");
  assert.equal(ctx.timeFormat, "24h");
  assert.equal(ctx.host, "cloudflare-worker");
  assert.equal(ctx.os, "Linux");
  assert.equal(ctx.thinkingLevel, "medium");
});

test("defaultPromptContext accepts overrides", () => {
  const ctx = defaultPromptContext({ timezone: "America/New_York", model: "llama-3.3-70b" });
  assert.equal(ctx.timezone, "America/New_York");
  assert.equal(ctx.model, "llama-3.3-70b");
  // defaults preserved
  assert.equal(ctx.os, "Linux");
});

// ── buildSystemPrompt – section presence ─────────────────────────────────────

test("buildSystemPrompt includes all six sections", () => {
  const ctx = defaultPromptContext({ sandboxEnabled: true, repoRoot: "/workspace/blob" });
  const prompt = buildSystemPrompt("Base instruction.", ctx);

  assert.ok(prompt.startsWith("Base instruction."), "starts with base prompt");
  assert.ok(prompt.includes("## Tooling"), "contains Tooling section");
  assert.ok(prompt.includes("## Safety"), "contains Safety section");
  assert.ok(prompt.includes("## Sandbox"), "contains Sandbox section");
  assert.ok(prompt.includes("## Current Date & Time"), "contains Date & Time section");
  assert.ok(prompt.includes("## Heartbeats"), "contains Heartbeats section");
  assert.ok(prompt.includes("## Runtime"), "contains Runtime section");
});

// ── Tooling section ──────────────────────────────────────────────────────────

test("Tooling section lists all four tools", () => {
  const ctx = defaultPromptContext();
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("**read**"));
  assert.ok(prompt.includes("**write**"));
  assert.ok(prompt.includes("**edit**"));
  assert.ok(prompt.includes("**bash**"));
});

// ── Safety section ───────────────────────────────────────────────────────────

test("Safety section includes guardrail language", () => {
  const ctx = defaultPromptContext();
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("Do not attempt to acquire capabilities beyond"));
  assert.ok(prompt.includes("oversight"));
});

// ── Sandbox section ──────────────────────────────────────────────────────────

test("Sandbox section omitted when disabled", () => {
  const ctx = defaultPromptContext({ sandboxEnabled: false });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(!prompt.includes("## Sandbox"), "should not contain Sandbox section");
});

test("Sandbox section includes path and elevated exec status", () => {
  const ctx = defaultPromptContext({ sandboxEnabled: true, sandboxPath: "/workspace/myrepo", elevatedExec: true });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("/workspace/myrepo"));
  assert.ok(prompt.includes("Elevated exec (sudo) is available"));
});

test("Sandbox section reports no elevated exec", () => {
  const ctx = defaultPromptContext({ sandboxEnabled: true, elevatedExec: false });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("Elevated exec is not available"));
});

// ── Date & Time section ──────────────────────────────────────────────────────

test("Date & Time section includes timezone and format", () => {
  const ctx = defaultPromptContext({ localDateTime: "2026-03-04T14:32:00", timezone: "America/Chicago", timeFormat: "12h" });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("2026-03-04T14:32:00"));
  assert.ok(prompt.includes("America/Chicago"));
  assert.ok(prompt.includes("12h"));
});

// ── Heartbeats section ───────────────────────────────────────────────────────

test("Heartbeats section includes interval and ack behavior", () => {
  const ctx = defaultPromptContext({ heartbeatInterval: "every 5 minutes" });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("every 5 minutes"));
  assert.ok(prompt.includes("acknowledge"));
});

// ── Runtime section ──────────────────────────────────────────────────────────

test("Runtime section includes host, OS, node, model, and thinking level", () => {
  const ctx = defaultPromptContext({
    host: "cf-worker",
    os: "Linux",
    nodeVersion: "v20.11.0",
    model: "llama-3.3-70b",
    thinkingLevel: "high",
  });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("cf-worker"));
  assert.ok(prompt.includes("Linux"));
  assert.ok(prompt.includes("v20.11.0"));
  assert.ok(prompt.includes("llama-3.3-70b"));
  assert.ok(prompt.includes("Thinking: high"));
});

test("Runtime section includes repo root when provided", () => {
  const ctx = defaultPromptContext({ repoRoot: "/workspace/blob" });
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(prompt.includes("Repo root: /workspace/blob"));
});

test("Runtime section omits repo root when not provided", () => {
  const ctx = defaultPromptContext();
  const prompt = buildSystemPrompt("", ctx);

  assert.ok(!prompt.includes("Repo root:"));
});
