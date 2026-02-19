"""Core ReAct-style agent loop."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

import config
from approval import ApprovalGate, classify_action
from llm_client import LLMClient
from safety import ModificationRateLimiter, git_auto_commit, is_constitution_file
from sandbox import SandboxExecutor
from tools import BASH_TOOL, format_tool_result


def _extract_target_files(command: str) -> list[str]:
    files: list[str] = []
    for token in command.replace(">>", " ").replace(">", " ").split():
        if token.endswith(".py") or token.endswith(".md") or token.endswith(".json"):
            files.append(token)
    return files


class Agent:
    def __init__(
        self,
        llm_client: LLMClient,
        sandbox: SandboxExecutor,
        approval_gate: ApprovalGate,
        on_status: Callable[[str], None] | None = None,
    ) -> None:
        self.llm_client = llm_client
        self.sandbox = sandbox
        self.approval_gate = approval_gate
        self.on_status = on_status
        self._system_prompt = self._build_system_prompt()
        self._base_messages: list[dict[str, object]] = []
        self.rate_limiter = ModificationRateLimiter()

    def _build_system_prompt(self) -> str:
        agent_md = Path(config.WORKSPACE_ROOT / "AGENT.md")
        knowledge = agent_md.read_text() if agent_md.exists() else ""
        return f"You are a self-modifying coding agent.\n\n{knowledge}"

    def run_task(self, task: str) -> str:
        messages = list(self._base_messages)
        messages.append({"role": "user", "content": [{"type": "text", "text": task}]})

        final_text = ""
        done = False
        steps = 0

        while not done and steps < config.MAX_STEPS:
            steps += 1
            if self.on_status:
                self.on_status(f"Step {steps}/{config.MAX_STEPS}: querying model")

            response = self.llm_client.create_message(
                model=config.MODEL_ROUTING["routine"],
                system=self._system_prompt,
                messages=messages,
                tools=[BASH_TOOL],
            )
            messages.append({"role": "assistant", "content": response.content})

            tool_uses = [block for block in response.content if block.get("type") == "tool_use"]
            if response.stop_reason == "end_turn" and not tool_uses:
                final_text = "\n".join(block.get("text", "") for block in response.content if block.get("type") == "text").strip()
                done = True
                break

            for tool_use in tool_uses:
                command = tool_use.get("input", {}).get("command", "")
                target_files = _extract_target_files(command)
                if any(is_constitution_file(path) for path in target_files):
                    result_text = "Blocked: constitution file modification is not allowed."
                else:
                    tier = classify_action(command, target_files)
                    allowed = self.approval_gate.request_approval(command, tier)
                    if not allowed:
                        result_text = "Blocked: approval denied or timed out."
                    elif target_files and not self.rate_limiter.can_modify():
                        result_text = "Blocked: self-modification rate limit reached."
                    else:
                        execution = self.sandbox.execute(command=command, timeout=config.COMMAND_TIMEOUT)
                        result_text = f"exit={execution.exit_code}\nstdout:\n{execution.stdout}\nstderr:\n{execution.stderr}"
                        if target_files and execution.exit_code == 0:
                            self.rate_limiter.record_modification()
                            git_auto_commit(f"agent: apply command `{command}`")

                messages.append(
                    {
                        "role": "user",
                        "content": [format_tool_result(tool_use_id=tool_use["id"], output=result_text)],
                    }
                )

        self._reset_conversation()
        return final_text or ""

    def _reset_conversation(self) -> None:
        self._base_messages = []


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the self-modifying agent")
    parser.add_argument("task", help="Task description to execute")
    args = parser.parse_args()

    from approval import SlackApprovalGate
    from llm_client import AnthropicClient
    from sandbox import FlySpriteSandbox

    class AutoApprove(ApprovalGate):
        def request_approval(self, action_description: str, tier: str) -> bool:
            return tier == "auto-approve"

    agent = Agent(
        llm_client=AnthropicClient(),
        sandbox=FlySpriteSandbox(),
        approval_gate=AutoApprove(),
    )
    result = agent.run_task(args.task)
    print(json.dumps({"result": result}, indent=2))


if __name__ == "__main__":
    main()
