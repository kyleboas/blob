import type { ToolResult } from "./types";
import { TOOL_OUTPUT_MAX_CHARS } from "./config";

export const BASH_TOOL = {
  name: "bash",
  description: "Execute a bash command inside the configured sandbox.",
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
