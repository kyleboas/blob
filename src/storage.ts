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

export interface Heartbeat {
  id: number;
  task: string;
  channel: string;
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  createdAt: number;
  updatedAt: number;
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

  sql.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS sub_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      do_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

export function resolveOrCreateSession(
  sql: SqlStorage,
  nowMs: number
): { sessionId: string; previousSessionId: string | null } {
  const rows = sql
    .exec(`SELECT current_session_id, last_message_at FROM session_state WHERE id = 1`)
    .toArray();

  const existing = rows[0];
  const timeoutMs = CONVERSATION_TIMEOUT_MINUTES * 60 * 1000;

  let sessionId: string;
  let previousSessionId: string | null = null;

  if (!existing || (nowMs - Number(existing.last_message_at)) > timeoutMs) {
    sessionId = `session:${nowMs}`;
    previousSessionId = existing ? String(existing.current_session_id) : null;
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

  return { sessionId, previousSessionId };
}

export function getCurrentSession(sql: SqlStorage): string | null {
  const rows = sql
    .exec(`SELECT current_session_id FROM session_state WHERE id = 1`)
    .toArray();
  return rows[0] ? String(rows[0].current_session_id) : null;
}

export interface SessionSummary {
  sessionId: string;
  summary: string;
  createdAt: number;
}

export function saveSessionSummary(sql: SqlStorage, sessionId: string, summary: string): void {
  sql.exec(
    `INSERT INTO session_summaries (session_id, summary) VALUES (?, ?)`,
    sessionId,
    summary
  );
}

export function getRecentSessionSummaries(sql: SqlStorage, limit: number): SessionSummary[] {
  const rows = sql
    .exec(
      `SELECT session_id, summary, created_at
       FROM session_summaries
       ORDER BY id DESC
       LIMIT ?`,
      limit
    )
    .toArray();

  return rows.reverse().map((row) => ({
    sessionId: String(row.session_id),
    summary: String(row.summary),
    createdAt: Number(row.created_at)
  }));
}

export function compactMessagesInDB(
  sql: SqlStorage,
  sessionId: string,
  compactedMessages: ConversationMessage[]
): void {
  sql.exec(`DELETE FROM conversation_messages WHERE thread_id = ?`, sessionId);
  for (const msg of compactedMessages) {
    const content = Array.isArray(msg.content) ? JSON.stringify(msg.content) : msg.content;
    sql.exec(
      `INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)`,
      sessionId,
      msg.role,
      content
    );
  }
}

export interface AgentEvent {
  eventType: string;
  message: string;
  createdAt: number;
}

export function saveMessage(sql: SqlStorage, threadId: string, msg: ConversationMessage): void {
  const content = Array.isArray(msg.content) ? JSON.stringify(msg.content) : msg.content;
  sql.exec(
    `INSERT INTO conversation_messages (thread_id, role, content) VALUES (?, ?, ?)`,
    threadId,
    msg.role,
    content
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

  return rows.map((row) => {
    const raw = String(row.content);
    let content: string | unknown[] = raw;
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) content = parsed;
      } catch {
        // Not a JSON array — treat as a plain string
      }
    }
    return {
      role: String(row.role) as ConversationMessage["role"],
      content
    };
  });
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

export function getAllRecentAgentEvents(sql: SqlStorage, limit = 200): AgentEvent[] {
  const rows = sql
    .exec(
      `SELECT event_type, message, created_at
       FROM agent_events
       ORDER BY id DESC
       LIMIT ?`,
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

  // Write files sequentially to avoid hammering a cold-starting sandbox with
  // concurrent requests, which can cause blockConcurrencyWhile() timeouts.
  for (const file of files) {
    await sandbox.writeFile(file.path, file.content);
  }

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
  sandbox: Pick<SandboxClient, "readFile">
): Promise<void> {
  try {
    const knowledge = await sandbox.readFile("AGENT.md");
    saveKnowledge(sql, knowledge);
  } catch {
    // AGENT.md does not exist in the sandbox – nothing to sync
  }
}

// Heartbeat functions – background work items Blob processes proactively

export function enqueueHeartbeat(sql: SqlStorage, task: string, channel: string): number {
  sql.exec(
    `INSERT INTO heartbeats (task, channel, status) VALUES (?, ?, 'pending')`,
    task,
    channel
  );
  const rows = sql.exec(`SELECT last_insert_rowid() AS id`).toArray();
  return Number(rows[0]?.id ?? 0);
}

export function getNextPendingHeartbeat(sql: SqlStorage): Heartbeat | null {
  const rows = sql
    .exec(
      `SELECT id, task, channel, status, result, created_at, updated_at
       FROM heartbeats
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT 1`
    )
    .toArray();

  if (rows.length === 0) return null;

  const row = rows[0];
  const id = Number(row.id);

  sql.exec(
    `UPDATE heartbeats SET status = 'running', updated_at = unixepoch() WHERE id = ?`,
    id
  );

  return {
    id,
    task: String(row.task),
    channel: String(row.channel),
    status: "running",
    result: null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export function completeHeartbeat(sql: SqlStorage, id: number, result: string): void {
  sql.exec(
    `UPDATE heartbeats SET status = 'completed', result = ?, updated_at = unixepoch() WHERE id = ?`,
    result,
    id
  );
}

export function failHeartbeat(sql: SqlStorage, id: number, error: string): void {
  sql.exec(
    `UPDATE heartbeats SET status = 'failed', result = ?, updated_at = unixepoch() WHERE id = ?`,
    error,
    id
  );
}

export function hasPendingHeartbeats(sql: SqlStorage): boolean {
  const rows = sql
    .exec(`SELECT 1 FROM heartbeats WHERE status = 'pending' LIMIT 1`)
    .toArray();
  return rows.length > 0;
}

export function listHeartbeats(sql: SqlStorage, limit = 50): Heartbeat[] {
  const rows = sql
    .exec(
      `SELECT id, task, channel, status, result, created_at, updated_at
       FROM heartbeats
       ORDER BY id DESC
       LIMIT ?`,
      limit
    )
    .toArray();

  return rows.map((row) => ({
    id: Number(row.id),
    task: String(row.task),
    channel: String(row.channel),
    status: String(row.status) as Heartbeat["status"],
    result: row.result != null ? String(row.result) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }));
}

// Sub-agent registry – tracks active sub-agent DOs spawned per channel so that
// approval reactions and other events can be broadcast to all running agents.

export function registerSubAgent(sql: SqlStorage, channel: string, doName: string): void {
  sql.exec(
    `INSERT OR IGNORE INTO sub_agents (channel, do_name) VALUES (?, ?)`,
    channel,
    doName
  );
}

export function listActiveSubAgents(sql: SqlStorage, channel: string): string[] {
  const rows = sql
    .exec(
      `SELECT do_name FROM sub_agents WHERE channel = ? AND status = 'running' ORDER BY id DESC`,
      channel
    )
    .toArray();
  return rows.map((row) => String(row.do_name));
}

export function markSubAgentDone(sql: SqlStorage, doName: string, status: "completed" | "failed"): void {
  sql.exec(
    `UPDATE sub_agents SET status = ?, updated_at = unixepoch() WHERE do_name = ?`,
    status,
    doName
  );
}
