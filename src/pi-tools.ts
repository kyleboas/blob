// Pi-style tools - 4 core tools + extension system

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// SqlStorage type matching Durable Object storage
type SqlStorage = {
  exec: (query: string, ...bindings: (string | number | null)[]) => { toArray: () => Array<Record<string, unknown>> };
};

// The 4 core Pi-style tools
export const CORE_TOOLS: Tool[] = [
  {
    name: "read",
    description: "Read the contents of a file. Use this to examine code, logs, or any text file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" }
      },
      required: ["path"]
    }
  },
  {
    name: "write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Use for creating new files or replacing entire files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write the file" },
        content: { type: "string", description: "Content to write" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit",
    description: "Edit a file by replacing specific text. Use for surgical changes when you want to preserve the rest of the file. oldText must match exactly.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        oldText: { type: "string", description: "Exact text to replace" },
        newText: { type: "string", description: "New text to insert" }
      },
      required: ["path", "oldText", "newText"]
    }
  },
  {
    name: "bash",
    description: "Execute a bash command. Use for running scripts, git operations, package installation, API calls via curl, etc. Commands run in a sandboxed environment.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" }
      },
      required: ["command"]
    }
  }
];

// Extension tool loaded from .blob/extensions/
export interface ExtensionTool extends Tool {
  scriptPath: string;  // Path to the implementation script
}

// Load extensions from .blob/extensions/
export function loadExtensions(sql: SqlStorage): ExtensionTool[] {
  const extensions: ExtensionTool[] = [];
  
  try {
    // Query extensions table
    const result = sql.exec(`
      SELECT name, description, script_path, input_schema 
      FROM extensions 
      WHERE enabled = 1
    `);
    
    for (const row of result.toArray()) {
      extensions.push({
        name: String(row.name),
        description: String(row.description),
        scriptPath: String(row.script_path),
        input_schema: JSON.parse(String(row.input_schema))
      });
    }
  } catch {
    // Extensions table might not exist yet
  }
  
  return extensions;
}

// Register a new extension (called when agent creates one)
export function registerExtension(
  sql: SqlStorage,
  name: string,
  description: string,
  scriptPath: string,
  inputSchema: Record<string, unknown>
): void {
  sql.exec(`
    INSERT OR REPLACE INTO extensions (name, description, script_path, input_schema, enabled, created_at)
    VALUES (?, ?, ?, ?, 1, unixepoch())
  `, name, description, scriptPath, JSON.stringify(inputSchema));
}

// Schema for extensions table
export const EXTENSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS extensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    script_path TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`;
