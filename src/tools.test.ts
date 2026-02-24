import { describe, expect, it } from "vitest";
import {
  BASH_TOOL,
  CREATE_TOOL_TOOL,
  compileDynamicToolCommand,
  dynamicToolToAnthropicSchema,
  formatToolResult,
  validateDynamicToolDefinition
} from "./tools";

describe("BASH_TOOL", () => {
  it("exposes required anthropic tool schema fields", () => {
    expect(BASH_TOOL.name).toBe("bash");
    expect(BASH_TOOL.input_schema.type).toBe("object");
    expect(BASH_TOOL.input_schema.required).toContain("command");
  });
});

describe("CREATE_TOOL_TOOL", () => {
  it("exposes a schema for creating tools", () => {
    expect(CREATE_TOOL_TOOL.name).toBe("create_tool");
    expect(CREATE_TOOL_TOOL.input_schema.required).toEqual(["name", "description", "command_template"]);
  });
});

describe("dynamic tools", () => {
  it("validates and compiles dynamic tool commands", () => {
    const validated = validateDynamicToolDefinition({
      name: "List Repo Files",
      description: "List repository files in a path",
      command_template: "find {path} -maxdepth 2 -type f",
      args: ["path"]
    });

    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }

    const anthropicSchema = dynamicToolToAnthropicSchema(validated.definition);
    expect(anthropicSchema.name).toBe("list_repo_files");
    expect(anthropicSchema.input_schema.required).toEqual(["path"]);

    const compiled = compileDynamicToolCommand(validated.definition, { path: "/workspace/blob" });
    expect(compiled).toEqual({ ok: true, command: "find /workspace/blob -maxdepth 2 -type f" });
  });

  it("rejects reserved names", () => {
    const validated = validateDynamicToolDefinition({
      name: "bash",
      description: "bad",
      command_template: "echo hi"
    });
    expect(validated).toEqual({ ok: false, reason: 'Tool name "bash" is reserved.' });
  });
});

describe("formatToolResult", () => {
  it("formats tool result blocks", () => {
    const result = formatToolResult("tool_1", "command output");
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "tool_1",
      content: [{ type: "text", text: "command output" }]
    });
  });

  it("truncates output larger than max chars", () => {
    const output = "a".repeat(12);
    const result = formatToolResult("tool_1", output, 10);
    expect(result.content[0].text).toContain("[output truncated: 2 characters omitted]");
  });
});
