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

MAKE_PR_TOOL = {
    "name": "make_pr",
    "description": "Create a GitHub pull request from the current branch.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "body": {"type": "string"},
            "repo": {"type": "string", "description": "owner/repo. Optional if origin points to GitHub."},
            "base": {"type": "string", "description": "Base branch. Defaults to origin default branch or main."},
            "head": {"type": "string", "description": "Head branch. Defaults to current branch."},
            "draft": {"type": "boolean"},
        },
        "required": ["title", "body"],
    },
}

PUSH_BRANCH_TOOL = {
    "name": "push_branch",
    "description": "Push a local branch to a GitHub remote so self-fixes can be shared.",
    "input_schema": {
        "type": "object",
        "properties": {
            "remote": {"type": "string", "description": "Git remote name. Defaults to origin."},
            "branch": {"type": "string", "description": "Local branch to push. Defaults to current branch."},
            "set_upstream": {"type": "boolean", "description": "Whether to set upstream tracking. Defaults to true."},
        },
        "required": [],
    },
}


SPAWN_SUBAGENT_TOOL = {
    "name": "spawn_subagent",
    "description": (
        "Spawn a sub-agent to handle an independent task concurrently with other sub-agents. "
        "Use this when the user requests multiple independent tasks that can be completed in parallel. "
        "Call spawn_subagent once per independent task; all spawned sub-agents run concurrently. "
        "Each sub-agent runs its own ReAct loop with isolated conversation history."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "description": "The task description for the sub-agent to complete.",
            },
        },
        "required": ["task"],
    },
}


def format_tool_result(tool_use_id: str, output: str) -> dict[str, object]:
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": [{"type": "text", "text": output}],
    }
