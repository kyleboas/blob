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
}

// Helper to generate session ID
export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
