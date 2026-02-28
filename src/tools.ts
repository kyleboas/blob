import { TOOL_OUTPUT_MAX_CHARS } from "./config";
import type { ToolResult } from "./types";

// Pi-style: 4 core tools only
// Everything else is built using these 4 tools via bash

export const READ_TOOL = {
  name: "read",
  description: "Read a file from the sandbox. Returns file contents as text. Use absolute paths (e.g. /workspace/file.txt).",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to read"
      }
    },
    required: ["path"]
  }
} as const;

export const WRITE_TOOL = {
  name: "write",
  description: "Write content to a file in the sandbox. Creates the file if it doesn't exist, overwrites if it does. Use absolute paths.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write"
      },
      content: {
        type: "string",
        description: "Content to write to the file"
      }
    },
    required: ["path", "content"]
  }
} as const;

export const EDIT_TOOL = {
  name: "edit",
  description: "Edit a file by replacing exact text. The old_text must match exactly (including whitespace). Use this for precise, surgical edits.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit"
      },
      old_text: {
        type: "string",
        description: "Exact text to find and replace (must match exactly including whitespace)"
      },
      new_text: {
        type: "string",
        description: "New text to replace the old text with"
      }
    },
    required: ["path", "old_text", "new_text"]
  }
} as const;

export const BASH_TOOL = {
  name: "bash",
  description: "Execute a bash command inside the configured sandbox. Use this for: running code, git operations, installing packages, fetching web content (curl), database queries (sqlite3), and any other system operations. The sandbox working directory is /workspace.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute"
      }
    },
    required: ["command"]
  }
} as const;

// All 4 core tools
export const CORE_TOOLS = [READ_TOOL, WRITE_TOOL, EDIT_TOOL, BASH_TOOL] as const;

// Helper to format tool results
export function formatToolResult(toolUseId: string, output: string, maxChars = TOOL_OUTPUT_MAX_CHARS): ToolResult {
  const trimmed = output.length > maxChars
    ? `${output.slice(0, maxChars)}\n\n[output truncated: ${output.length - maxChars} characters omitted]`
    : output;

  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [{ type: "text", text: trimmed }]
  };
}
