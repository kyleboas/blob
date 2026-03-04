/**
 * System prompt template builder.
 *
 * Every prompt assembled by `buildSystemPrompt` includes the six required
 * sections in a deterministic order:
 *   1. Tooling – the four sandbox tools with one-line descriptions.
 *   2. Safety – a short guardrail reminder.
 *   3. Sandbox – sandbox runtime details (only when enabled).
 *   4. Current Date & Time – user-local time, timezone and format.
 *   5. Heartbeats – heartbeat cadence and ack expectations.
 *   6. Runtime – host, OS, node version, model, repo root, thinking level.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromptContext {
  /** Whether the sandbox is available for this session. */
  sandboxEnabled: boolean;

  /** Absolute sandbox workspace path, e.g. "/workspace/blob". */
  sandboxPath?: string;

  /** Whether elevated exec (root / sudo) is available in the sandbox. */
  elevatedExec?: boolean;

  /** ISO-8601 date-time string in the user's local timezone (e.g. "2026-03-04T14:32:00"). */
  localDateTime: string;

  /** IANA timezone identifier (e.g. "America/New_York"). */
  timezone: string;

  /** Preferred time format: "12h" or "24h". */
  timeFormat: "12h" | "24h";

  /** Heartbeat interval description, e.g. "every 10 minutes". */
  heartbeatInterval: string;

  /** Runtime host name (e.g. "cloudflare-worker"). */
  host: string;

  /** Operating system (e.g. "Linux"). */
  os: string;

  /** Node / runtime version string. */
  nodeVersion: string;

  /** Model identifier (e.g. "llama-3.3-70b-instruct"). */
  model: string;

  /** Absolute path to the repository root, if detected. */
  repoRoot?: string;

  /** Thinking level: "none", "low", "medium", or "high". */
  thinkingLevel: "none" | "low" | "medium" | "high";
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildToolingSection(): string {
  return `## Tooling
You have access to four tools:
- **read** – Read a file from the workspace.
- **write** – Create or overwrite a file in the workspace.
- **edit** – Apply a targeted find-and-replace edit to a file.
- **bash** – Execute a shell command in the sandbox.`;
}

function buildSafetySection(): string {
  return `## Safety
Do not attempt to acquire capabilities beyond what is explicitly granted. Do not circumvent, disable, or ignore oversight mechanisms. Always operate within the boundaries of the current session.`;
}

function buildSandboxSection(ctx: PromptContext): string | null {
  if (!ctx.sandboxEnabled) return null;

  const path = ctx.sandboxPath ?? "/workspace";
  const elevated = ctx.elevatedExec ? "Elevated exec (sudo) is available." : "Elevated exec is not available.";

  return `## Sandbox
Runtime is sandboxed. Workspace path: ${path}. ${elevated}`;
}

function buildDateTimeSection(ctx: PromptContext): string {
  return `## Current Date & Time
${ctx.localDateTime} (${ctx.timezone}, ${ctx.timeFormat}).`;
}

function buildHeartbeatSection(ctx: PromptContext): string {
  return `## Heartbeats
The system sends a heartbeat ${ctx.heartbeatInterval}. When you receive one, acknowledge it briefly and continue working. Do not treat a heartbeat as a new instruction.`;
}

function buildRuntimeSection(ctx: PromptContext): string {
  const parts = [
    `Host: ${ctx.host}`,
    `OS: ${ctx.os}`,
    `Node: ${ctx.nodeVersion}`,
    `Model: ${ctx.model}`,
  ];

  if (ctx.repoRoot) {
    parts.push(`Repo root: ${ctx.repoRoot}`);
  }

  parts.push(`Thinking: ${ctx.thinkingLevel}`);

  return `## Runtime
${parts.join(" | ")}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a complete system prompt from a base instruction and a `PromptContext`.
 *
 * The six required sections are appended after the base prompt.
 */
export function buildSystemPrompt(basePrompt: string, ctx: PromptContext): string {
  const sections: string[] = [basePrompt];

  sections.push(buildToolingSection());
  sections.push(buildSafetySection());

  const sandbox = buildSandboxSection(ctx);
  if (sandbox) {
    sections.push(sandbox);
  }

  sections.push(buildDateTimeSection(ctx));
  sections.push(buildHeartbeatSection(ctx));
  sections.push(buildRuntimeSection(ctx));

  return sections.join("\n\n");
}

/**
 * Create a `PromptContext` with sensible defaults for a typical Blob sandbox
 * session.  Callers can override any field.
 */
export function defaultPromptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sandboxEnabled: true,
    sandboxPath: "/workspace",
    elevatedExec: false,
    localDateTime: new Date().toISOString().slice(0, 19),
    timezone: "UTC",
    timeFormat: "24h",
    heartbeatInterval: "every 10 minutes",
    host: "cloudflare-worker",
    os: "Linux",
    nodeVersion: "N/A",
    model: "unknown",
    thinkingLevel: "medium",
    ...overrides,
  };
}
