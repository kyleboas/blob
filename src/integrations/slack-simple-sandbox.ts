import { buildRepoBootstrapScript, repoDirFromSlug } from "../agent/repo-diagnosis";
import { callLLM } from "../core/llm";
import { logEvent } from "../core/observability";
import { getRepos } from "../core/storage";
import type { Env } from "../core/types";
import { executeInSandbox, readTool, writeTool } from "./sandbox";
import { normalizeCommandText } from "./slack-commands";

export type DirectSandboxTask =
  | { kind: "read"; path: string; prompt?: string }
  | { kind: "bash"; command: string }
  | { kind: "write"; path: string; content: string; readBack: boolean };

function summarizeText(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(truncated)`;
}

function stripWrappingToken(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("`") && trimmed.endsWith("`")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripWriteSuffixes(value: string): { content: string; readBack: boolean } {
  const trimmed = value.trim();
  const readBackPattern = /(?:,?\s*then\s+read\s+it\s+back)\s*$/i;
  const readBack = readBackPattern.test(trimmed);
  const content = trimmed.replace(readBackPattern, "").trim();
  return { content: stripWrappingToken(content), readBack };
}

function stripCommandSuffix(value: string): string {
  return value
    .trim()
    .replace(/\s+and\s+tell\s+me\s+(?:the\s+)?(?:result|output|version)\s*$/i, "")
    .replace(/\s+and\s+tell\s+me\s+what\s+happened\s*$/i, "")
    .trim();
}

function isSimpleShellCommand(command: string): boolean {
  if (!command || command.length > 120) return false;
  if (/[\r\n]/.test(command)) return false;
  if (/[;&|><`]/.test(command)) return false;
  if (/\$\(/.test(command)) return false;
  return true;
}

export function parseDirectSandboxTask(text: string): DirectSandboxTask | null {
  const normalized = normalizeCommandText(text);

  const readMatch = normalized.match(/^(?:read|open|show|inspect|cat)\s+(?:the\s+file\s+|file\s+)?(?<path>`[^`]+`|"[^"]+"|[^\s,]+)(?<rest>[\s\S]*)$/i);
  if (readMatch?.groups?.path) {
    const path = stripWrappingToken(readMatch.groups.path);
    const rest = readMatch.groups.rest.trim().replace(/^and\s+/i, "").trim();
    if (path) return { kind: "read", path, prompt: rest || undefined };
  }

  const writeMatch = normalized.match(/^(?:create|write)\s+(?:a\s+file\s+(?:called|named|to)\s+|file\s+(?:called|named|to)\s+)?(?<path>`[^`]+`|"[^"]+"|[^\s,]+)\s+with\s+(?:the\s+)?(?:text|content)\s+(?<content>[\s\S]+)$/i);
  if (writeMatch?.groups?.path && writeMatch.groups.content) {
    const path = stripWrappingToken(writeMatch.groups.path);
    const { content, readBack } = stripWriteSuffixes(writeMatch.groups.content);
    if (path && content) return { kind: "write", path, content, readBack };
  }

  const runMatch = normalized.match(/^(?:run|execute)\s+(?<command>[\s\S]+)$/i);
  if (runMatch?.groups?.command) {
    const command = stripCommandSuffix(runMatch.groups.command);
    if (isSimpleShellCommand(command)) {
      return { kind: "bash", command };
    }
  }

  return null;
}

function getGitEnv(env: Env): Record<string, string> | undefined {
  if (!env.GITHUB_TOKEN) return undefined;
  return {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GIT_ASKPASS: "/usr/local/bin/blob-git-askpass",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function ensureRepoWorkspace(env: Env, sandboxId: string): Promise<{ repo: string; repoDir: string }> {
  const repos = await getRepos(env);
  const repo = repos[0];
  if (!repo) {
    throw new Error("No repo configured.");
  }

  const repoDir = repoDirFromSlug(repo);
  const bootstrap = await executeInSandbox(buildRepoBootstrapScript(repoDir, repo), env, {
    sandboxId,
    timeout: 180000,
    envVars: getGitEnv(env),
  });
  if (bootstrap.exitCode !== 0) {
    throw new Error(bootstrap.stderr || bootstrap.stdout || "repo bootstrap failed");
  }
  return { repo, repoDir };
}

async function answerReadPrompt(path: string, prompt: string | undefined, content: string, env: Env): Promise<string> {
  if (!prompt) {
    return `Read ${path}:\n\n${summarizeText(content)}`;
  }

  try {
    const response = await callLLM([
      {
        role: "system",
        content: "You answer a Slack question about a repository file. Use only the provided file content. Be concise and specific.",
      },
      {
        role: "user",
        content: `File path: ${path}\nQuestion: ${prompt}\n\nFile content:\n${summarizeText(content, 12000)}`,
      },
    ], env, { maxTokens: 500 });
    return response.trim() || `Read ${path}:\n\n${summarizeText(content)}`;
  } catch (_err) {
    return `Read ${path}:\n\n${summarizeText(content)}`;
  }
}

function formatCommandResult(command: string, stdout: string, stderr: string, exitCode: number): string {
  const parts = [`Command: ${command}`, `Exit code: ${exitCode}`];
  if (stdout.trim()) parts.push(`stdout:\n${summarizeText(stdout)}`);
  if (stderr.trim()) parts.push(`stderr:\n${summarizeText(stderr)}`);
  if (!stdout.trim() && !stderr.trim()) parts.push("No output.");
  return parts.join("\n\n");
}

export async function runDirectSandboxTask(
  task: DirectSandboxTask,
  env: Env,
  sandboxId: string,
): Promise<string> {
  logEvent(env, "slack_ingest", "direct_sandbox_task", { kind: task.kind });

  if (task.kind === "bash") {
    const result = await executeInSandbox(task.command, env, {
      sandboxId,
      workspaceRoot: "/workspace",
      timeout: Number.parseInt(env.BASH_TIMEOUT_MS ?? "120000", 10),
    });
    return formatCommandResult(task.command, result.stdout, result.stderr, result.exitCode);
  }

  const { repoDir } = await ensureRepoWorkspace(env, sandboxId);
  const workspaceRoot = `/workspace/${repoDir}`;

  if (task.kind === "read") {
    const content = await readTool(task.path, env, { sandboxId, workspaceRoot });
    return answerReadPrompt(task.path, task.prompt, content, env);
  }

  await writeTool(task.path, task.content, env, { sandboxId, workspaceRoot });
  if (!task.readBack) {
    return `Wrote ${task.path}.`;
  }

  const content = await readTool(task.path, env, { sandboxId, workspaceRoot });
  return `Wrote ${task.path}.\n\nRead back:\n${summarizeText(content)}`;
}
