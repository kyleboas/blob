// SqlStorage type matching Durable Object storage
type SqlStorage = {
  exec: (query: string, ...bindings: (string | number | null)[]) => { toArray: () => Array<Record<string, unknown>> };
};

export interface SessionNode {
  id: string;
  parentId: string | null;
  messages: SessionMessage[];
  metadata: SessionMetadata;
  createdAt: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  output: string;
  exitCode?: number;
}

export interface SessionMetadata {
  title?: string;
  summary?: string;
  tags?: string[];
  [key: string]: unknown;
}

// Extension state - stored in session but not sent to AI
export interface ExtensionState {
  [extensionName: string]: {
    data: unknown;
    updatedAt: number;
  };
}

// Session tree operations
export class SessionTree {
  constructor(private db: SqlStorage) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        messages TEXT NOT NULL, -- JSON array
        metadata TEXT NOT NULL, -- JSON object
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (parent_id) REFERENCES session_nodes(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_parent ON session_nodes(parent_id)
    `);

    // Extension state table - stores data that extensions want to persist
    // This data is NOT sent to the AI, it's for extension use only
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_state (
        session_id TEXT NOT NULL,
        extension_name TEXT NOT NULL,
        data TEXT NOT NULL, -- JSON object
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (session_id, extension_name),
        FOREIGN KEY (session_id) REFERENCES session_nodes(id) ON DELETE CASCADE
      )
    `);
  }

  // Create root node
  createRoot(id: string, metadata: SessionMetadata = {}): SessionNode {
    const node: SessionNode = {
      id,
      parentId: null,
      messages: [],
      metadata,
      createdAt: Date.now()
    };

    this.db.exec(`
      INSERT INTO session_nodes (id, parent_id, messages, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, id, null, JSON.stringify([]), JSON.stringify(metadata), node.createdAt);

    return node;
  }

  // Create child node (branch)
  createBranch(parentId: string, metadata: SessionMetadata = {}): SessionNode {
    const id = `${parentId}:${Date.now()}`;
    const parent = this.getNode(parentId);
    
    if (!parent) {
      throw new Error(`Parent node ${parentId} not found`);
    }

    // Copy parent's messages
    const node: SessionNode = {
      id,
      parentId,
      messages: [...parent.messages],
      metadata: { ...parent.metadata, ...metadata },
      createdAt: Date.now()
    };

    this.db.exec(`
      INSERT INTO session_nodes (id, parent_id, messages, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, id, parentId, JSON.stringify(node.messages), JSON.stringify(node.metadata), node.createdAt);

    // Copy parent's extension states to the new branch
    this.copyExtensionStates(parentId, id);

    return node;
  }

  // Get node by ID
  getNode(id: string): SessionNode | null {
    const result = this.db.exec(`
      SELECT id, parent_id, messages, metadata, created_at
      FROM session_nodes
      WHERE id = ?
    `, id);

    const row = result.toArray()[0];
    if (!row) return null;

    return {
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      messages: JSON.parse(String(row.messages)),
      metadata: JSON.parse(String(row.metadata)),
      createdAt: Number(row.created_at)
    };
  }

  // Get full path from root to node
  getPath(nodeId: string): SessionNode[] {
    const path: SessionNode[] = [];
    let currentId: string | null = nodeId;

    while (currentId) {
      const node = this.getNode(currentId);
      if (!node) break;
      path.unshift(node);
      currentId = node.parentId;
    }

    return path;
  }

  // Get all children of a node
  getChildren(parentId: string): SessionNode[] {
    const result = this.db.exec(`
      SELECT id, parent_id, messages, metadata, created_at
      FROM session_nodes
      WHERE parent_id = ?
      ORDER BY created_at
    `, parentId);

    return result.toArray().map(row => ({
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      messages: JSON.parse(String(row.messages)),
      metadata: JSON.parse(String(row.metadata)),
      createdAt: Number(row.created_at)
    }));
  }

  // Add message to node
  addMessage(nodeId: string, message: SessionMessage): void {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    node.messages.push(message);

    this.db.exec(`
      UPDATE session_nodes
      SET messages = ?
      WHERE id = ?
    `, JSON.stringify(node.messages), nodeId);
  }

  // Update metadata
  updateMetadata(nodeId: string, metadata: Partial<SessionMetadata>): void {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    const updatedMetadata = { ...node.metadata, ...metadata };

    this.db.exec(`
      UPDATE session_nodes
      SET metadata = ?
      WHERE id = ?
    `, JSON.stringify(updatedMetadata), nodeId);
  }

  // Rewind: create new branch at specific point in history
  rewind(nodeId: string, messageIndex: number, metadata: SessionMetadata = {}): SessionNode {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (messageIndex < 0 || messageIndex >= node.messages.length) {
      throw new Error(`Invalid message index ${messageIndex}`);
    }

    // Create branch with truncated messages
    const branchId = `${nodeId}:rewind:${Date.now()}`;
    const truncatedMessages = node.messages.slice(0, messageIndex + 1);

    this.db.exec(`
      INSERT INTO session_nodes (id, parent_id, messages, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, branchId, nodeId, JSON.stringify(truncatedMessages), JSON.stringify(metadata), Date.now());

    // Copy extension states to the rewound branch
    this.copyExtensionStates(nodeId, branchId);

    return {
      id: branchId,
      parentId: nodeId,
      messages: truncatedMessages,
      metadata,
      createdAt: Date.now()
    };
  }

  // Summarize what happened in a branch (for showing in parent)
  summarizeBranch(nodeId: string): string {
    const node = this.getNode(nodeId);
    if (!node) return "";

    const children = this.getChildren(nodeId);
    if (children.length === 0) return "";

    const summaries = children
      .map(child => child.metadata.summary)
      .filter(Boolean);

    if (summaries.length === 0) return "";

    return `Branch activity: ${summaries.join("; ")}`;
  }

  // Extension State Management
  // Stores data that extensions want to persist per session
  // This data is NOT sent to the AI - it's for extension use only

  /**
   * Get extension state for a session
   * @param sessionId - The session/node ID
   * @param extensionName - Unique name of the extension
   * @returns The stored data, or null if not found
   */
  getExtensionState(sessionId: string, extensionName: string): unknown | null {
    const result = this.db.exec(`
      SELECT data FROM extension_state
      WHERE session_id = ? AND extension_name = ?
    `, sessionId, extensionName);

    const rows = result.toArray();
    if (rows.length === 0) return null;

    try {
      return JSON.parse(String(rows[0].data));
    } catch {
      return null;
    }
  }

  /**
   * Set extension state for a session
   * @param sessionId - The session/node ID
   * @param extensionName - Unique name of the extension
   * @param data - Data to store (must be JSON serializable)
   */
  setExtensionState(sessionId: string, extensionName: string, data: unknown): void {
    const now = Date.now();
    const jsonData = JSON.stringify(data);

    this.db.exec(`
      INSERT INTO extension_state (session_id, extension_name, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, extension_name) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `, sessionId, extensionName, jsonData, now);
  }

  /**
   * Delete extension state for a session
   * @param sessionId - The session/node ID
   * @param extensionName - Unique name of the extension
   */
  deleteExtensionState(sessionId: string, extensionName: string): void {
    this.db.exec(`
      DELETE FROM extension_state
      WHERE session_id = ? AND extension_name = ?
    `, sessionId, extensionName);
  }

  /**
   * Get all extension states for a session
   * @param sessionId - The session/node ID
   * @returns Object mapping extension names to their data
   */
  getAllExtensionStates(sessionId: string): Record<string, unknown> {
    const result = this.db.exec(`
      SELECT extension_name, data FROM extension_state
      WHERE session_id = ?
    `, sessionId);

    const states: Record<string, unknown> = {};
    for (const row of result.toArray()) {
      try {
        states[String(row.extension_name)] = JSON.parse(String(row.data));
      } catch {
        // Skip invalid JSON
      }
    }
    return states;
  }

  /**
   * Copy all extension states from one session to another
   * Useful when creating branches
   * @param fromSessionId - Source session ID
   * @param toSessionId - Destination session ID
   */
  copyExtensionStates(fromSessionId: string, toSessionId: string): void {
    const states = this.getAllExtensionStates(fromSessionId);
    for (const [extensionName, data] of Object.entries(states)) {
      this.setExtensionState(toSessionId, extensionName, data);
    }
  }
}

// Helper to generate session ID
export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
