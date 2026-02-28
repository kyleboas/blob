"""Tool definitions used by the agent loop."""

from __future__ import annotations

READ_TOOL = {
    "name": "read",
    "description": "Read a file from the sandbox. Returns file contents as text. Use absolute paths.",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file to read"},
        },
        "required": ["path"],
    },
}

WRITE_TOOL = {
    "name": "write",
    "description": "Write content to a file in the sandbox. Creates the file if it doesn't exist, overwrites if it does. Use absolute paths.",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file to write"},
            "content": {"type": "string", "description": "Content to write to the file"},
        },
        "required": ["path", "content"],
    },
}

EDIT_TOOL = {
    "name": "edit",
    "description": "Edit a file by replacing exact text. The old_text must match exactly (including whitespace).",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file to edit"},
            "old_text": {"type": "string", "description": "Exact text to find and replace"},
            "new_text": {"type": "string", "description": "New text to replace the old text with"},
        },
        "required": ["path", "old_text", "new_text"],
    },
}

BASH_TOOL = {
    "name": "bash",
    "description": "Execute a bash command inside the configured sandbox.",
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string"},
        },
        "required": ["command"],
    },
}

CORE_TOOLS = [READ_TOOL, WRITE_TOOL, EDIT_TOOL, BASH_TOOL]


def format_tool_result(tool_use_id: str, output: str) -> dict[str, object]:
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": [{"type": "text", "text": output}],
    }
