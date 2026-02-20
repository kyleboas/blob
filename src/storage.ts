import type { ConversationMessage } from "./types";
import type { SandboxClient } from "./sandbox-client";
import { CONVERSATION_TIMEOUT_MINUTES } from "./config";

const KNOWLEDGE_KEY = "knowledge";

export interface SqlStatementResult<T> {
  toArray(): T[];
}

export interface SqlStorage {
  exec(query: string, ...bindings: Array<string | number | null>): SqlStatementResult<Record<string, unknown>>;
}

export interface RepoSnapshotFile {
  path: string;
  content: string;
}

const SNAPSHOT_FILES = ["AGENT.md", "README.md", "package.json", "tsconfig.json"];

function parseChangedPaths(gitStatusOutput: string): string[] {
  const paths: string[] = [];

  for (const rawLine of gitStatusOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.length < 4) {
      continue;
    }

    const status = line.slice(0, 2);
    // Skip deleted files. They should remain deleted on restore.
    if (status.includes("D")) {
      continue;
    }

    const pathSpec = line.slice(3).trim();
    if (!pathSpec) {
      continue;
    }

    const resolvedPath = pathSpec.includes(" -> ") ? pathSpec.split(" -> ").at(-1) ?? "" : pathSpec;
    if (!resolvedPath) {
      continue;
    }

    paths.push(resolvedPath);
  }

  return paths;
}

async function getSnapshotCandidates(
  sandbox: Pick<SandboxClient, "exec">,
  basePaths: string[]
): Promise<string[]> {
  const gitStatus = await sandbox.exec("git status --porcelain=v1 -uall");
  if (gitStatus.exitCode !== 0) {
    return basePaths;
  }

  return Array.from(new Set([...basePaths, ...parseChangedPaths(gitStatus.stdout)]));
}

export function initSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_state (
      session_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (scope, key)
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS approval_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      decision TEXT NOT NULL,
      decided_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS session_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_session_id TEXT NOT NULL,
      last_message_at INTEGER NOT NULL
    )
  `);
}

export function resolveOrCreateSession(sql: SqlStorage, nowMs: number): string {
  const rows = sql
    .exec(`SELECT current_session_id, last_message_at FROM session_state WHERE id = 1`)
    .toArray();

  const existing = rows[0];
  const timeoutMs = CONVERSATION_TIMEOUT_MINUTES * 60 * 1000;

  let sessionId: string;
  if (!existing || (nowMs - Number(existing.last_message_at)) > timeoutMs) {
    sessionId = `session:${nowMs}`;
  } else {
    sessionId = String(existing.current_session_id);
  }

  sql.exec(
    `INSERT INTO session_state (id, current_session_id, last_message_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       current_session_id = excluded.current_session_id,
       last_message_at = excluded.last_message_at`,
    sessionId,
    nowMs
  );

  return sessionId;
}

export function getCurrentSession(sql: SqlStorage): string | null {
  const rows = sql
    .exec(`SELECT current_session_id FROM session_state WHERE id = 1`)
    .toArray();
  return rows[0] ? String(rows[0].current_session_id) : null;
}

export interface AgentEvent {
  eventType: string;
  message: string;
  createdAt: number;
}

export function saveMessage(sql: SqlStorage, threadId: string, msg: ConversationMessage): void {
  sql.exec(
    `INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)`,
    threadId,
    msg.role,
    msg.content
  );
}

export function getHistory(sql: SqlStorage, threadId: string): ConversationMessage[] {
  const rows = sql
    .exec(
      `SELECT role, content
       FROM conversation_messages
       WHERE thread_id = ?
       ORDER BY id ASC`,
      threadId
    )
    .toArray();

  return rows.map((row) => ({
    role: String(row.role) as ConversationMessage["role"],
    content: String(row.content)
  }));
}

export function incrementRateLimit(sql: SqlStorage, scope: string, key: string): number {
  sql.exec(
    `INSERT INTO rate_limits (scope, key, count)
     VALUES (?, ?, 1)
     ON CONFLICT(scope, key)
     DO UPDATE SET count = count + 1, updated_at = unixepoch()`,
    scope,
    key
  );

  return getRateLimit(sql, scope, key);
}

export function getRateLimit(sql: SqlStorage, scope: string, key: string): number {
  const rows = sql.exec(`SELECT count FROM rate_limits WHERE scope = ? AND key = ?`, scope, key).toArray();
  if (rows.length === 0) {
    return 0;
  }

  return Number(rows[0].count ?? 0);
}

export function logAgentEvent(sql: SqlStorage, threadId: string, eventType: string, message: string): void {
  sql.exec(
    `INSERT INTO agent_events (thread_id, event_type, message) VALUES (?, ?, ?)`,
    threadId,
    eventType,
    message
  );
}

export function getRecentAgentEvents(sql: SqlStorage, threadId: string, limit = 200): AgentEvent[] {
  const rows = sql
    .exec(
      `SELECT event_type, message, created_at
       FROM agent_events
       WHERE thread_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      threadId,
      limit
    )
    .toArray();

  return rows.reverse().map((row) => ({
    eventType: String(row.event_type),
    message: String(row.message),
    createdAt: Number(row.created_at)
  }));
}



export function saveApprovalDecision(
  sql: SqlStorage,
  sessionId: string,
  command: string,
  decision: "approved" | "denied" | "timed_out",
  decidedBy: string | null
): void {
  sql.exec(
    `INSERT INTO approval_log (session_id, command, decision, decided_by) VALUES (?, ?, ?, ?)`,
    sessionId,
    command,
    decision,
    decidedBy
  );
}

export function saveKnowledge(sql: SqlStorage, content: string): void {
  sql.exec(
    `INSERT INTO knowledge (key, content)
     VALUES (?, ?)
     ON CONFLICT(key)
     DO UPDATE SET content = excluded.content, updated_at = unixepoch()`,
    KNOWLEDGE_KEY,
    content
  );
}

export function getKnowledge(sql: SqlStorage): string {
  const rows = sql.exec(`SELECT content FROM knowledge WHERE key = ?`, KNOWLEDGE_KEY).toArray();
  return String(rows[0]?.content ?? "");
}

export async function saveRepoSnapshot(
  r2: R2Bucket,
  sessionId: string,
  sandbox: Pick<SandboxClient, "fileExists" | "readFile" | "exec">
): Promise<void> {
  const candidates = await getSnapshotCandidates(sandbox, SNAPSHOT_FILES);
  const results = await Promise.all(
    candidates.map(async (path) => {
      if (await sandbox.fileExists(path)) {
        return { path, content: await sandbox.readFile(path) };
      }
      return null;
    })
  );
  const files = results.filter((f): f is RepoSnapshotFile => f !== null);

  await r2.put(`snapshots/${sessionId}.json`, JSON.stringify(files));
}

export const __testables = {
  parseChangedPaths
};

export async function restoreRepoSnapshot(
  r2: R2Bucket,
  sessionId: string,
  sandbox: Pick<SandboxClient, "writeFile">
): Promise<boolean> {
  const object = await r2.get(`snapshots/${sessionId}.json`);
  if (!object || typeof object !== "object" || !("text" in object)) {
    return false;
  }

  const raw = await (object as { text(): Promise<string> }).text();
  const files = JSON.parse(raw) as RepoSnapshotFile[];

  await Promise.all(files.map((file) => sandbox.writeFile(file.path, file.content)));

  return true;
}

export async function syncKnowledgeToSandbox(
  sql: SqlStorage,
  sandbox: Pick<SandboxClient, "writeFile">
): Promise<void> {
  const knowledge = getKnowledge(sql);
  if (!knowledge) {
    return;
  }
  await sandbox.writeFile("AGENT.md", knowledge);
}

export async function syncKnowledgeFromSandbox(
  sql: SqlStorage,
  sandbox: Pick<SandboxClient, "readFile" | "fileExists">
): Promise<void> {
  if (!(await sandbox.fileExists("AGENT.md"))) {
    return;
  }
  const knowledge = await sandbox.readFile("AGENT.md");
  saveKnowledge(sql, knowledge);
}
