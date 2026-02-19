"""Tool definitions used by the agent loop."""

from __future__ import annotations

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


def format_tool_result(tool_use_id: str, output: str) -> dict[str, object]:
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": [{"type": "text", "text": output}],
    }
