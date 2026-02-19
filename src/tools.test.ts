import { describe, expect, it } from "vitest";
import { BASH_TOOL, formatToolResult } from "./tools";

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
