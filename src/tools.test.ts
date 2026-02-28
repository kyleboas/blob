import { describe, expect, it } from "vitest";
import {
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  BASH_TOOL,
  formatToolResult
} from "./tools";

describe("READ_TOOL", () => {
  it("exposes required anthropic tool schema fields", () => {
    expect(READ_TOOL.name).toBe("read");
    expect(READ_TOOL.input_schema.type).toBe("object");
    expect(READ_TOOL.input_schema.required).toContain("path");
  });
});

describe("WRITE_TOOL", () => {
  it("exposes required anthropic tool schema fields", () => {
    expect(WRITE_TOOL.name).toBe("write");
    expect(WRITE_TOOL.input_schema.type).toBe("object");
    expect(WRITE_TOOL.input_schema.required).toEqual(["path", "content"]);
  });
});

describe("EDIT_TOOL", () => {
  it("exposes required anthropic tool schema fields", () => {
    expect(EDIT_TOOL.name).toBe("edit");
    expect(EDIT_TOOL.input_schema.type).toBe("object");
    expect(EDIT_TOOL.input_schema.required).toEqual(["path", "old_text", "new_text"]);
  });
});

describe("BASH_TOOL", () => {
  it("exposes required anthropic tool schema fields", () => {
    expect(BASH_TOOL.name).toBe("bash");
    expect(BASH_TOOL.input_schema.type).toBe("object");
    expect(BASH_TOOL.input_schema.required).toContain("command");
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
