"""Core ReAct-style agent loop and self-improvement orchestration."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen
from typing import Callable

import config
from approval import ApprovalGate, classify_action
from llm_client import LLMClient
from safety import git_auto_commit, git_checkpoint, git_revert_to_checkpoint, is_constitution_file
from sandbox import SandboxExecutor
from tools import BASH_TOOL, format_tool_result


class _HTMLToTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []

    def handle_data(self, data: str) -> None:
        cleaned = data.strip()
        if cleaned:
            self._chunks.append(cleaned)

    def as_markdown(self) -> str:
        return "\n\n".join(self._chunks)


def _extract_target_files(command: str) -> list[str]:
    files: list[str] = []
    for token in command.replace(">>", " ").replace(">", " ").split():
        if token.endswith(".py") or token.endswith(".md") or token.endswith(".json"):
            files.append(token)
    return files


@dataclass(slots=True)
class ImprovementTask:
    id: str
    title: str
    status: str


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

    def _build_system_prompt(self) -> str:
        agent_md = Path(config.WORKSPACE_ROOT / "AGENT.md")
        knowledge = agent_md.read_text() if agent_md.exists() else ""
        return f"You are a self-modifying coding agent.\n\n{knowledge}"

    def _emit_status(self, message: str) -> None:
        if self.on_status:
            self.on_status(message)

    def run_task(self, task: str, extra_context: str = "") -> str:
        messages = list(self._base_messages)
        task_text = task
        if extra_context:
            task_text = f"{task}\n\nAdditional context:\n{extra_context}"
        messages.append({"role": "user", "content": [{"type": "text", "text": task_text}]})

        final_text = ""
        done = False
        steps = 0

        while not done and steps < config.MAX_STEPS:
            steps += 1
            self._emit_status(f"Step {steps}/{config.MAX_STEPS}: querying model")

            response = self.llm_client.create_message(
                model=config.MODEL_ROUTING["routine"],
                system=self._system_prompt,
                messages=messages,
                tools=[BASH_TOOL],
            )
            messages.append({"role": "assistant", "content": response.content})

            tool_uses = [block for block in response.content if block.get("type") == "tool_use"]
            if response.stop_reason == "end_turn" and not tool_uses:
                final_text = "\n".join(
                    block.get("text", "") for block in response.content if block.get("type") == "text"
                ).strip()
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
                    else:
                        execution = self.sandbox.execute(command=command, timeout=config.COMMAND_TIMEOUT)
                        result_text = f"exit={execution.exit_code}\nstdout:\n{execution.stdout}\nstderr:\n{execution.stderr}"

                messages.append(
                    {
                        "role": "user",
                        "content": [format_tool_result(tool_use_id=tool_use["id"], output=result_text)],
                    }
                )

        self._reset_conversation()
        return final_text or ""

    def _load_task_queue(self, tasks_path: Path) -> list[dict[str, str]]:
        raw = json.loads(tasks_path.read_text())
        return [dict(item) for item in raw]

    def _write_task_queue(self, tasks_path: Path, tasks: list[dict[str, str]]) -> None:
        tasks_path.write_text(json.dumps(tasks, indent=2) + "\n")

    def get_next_task(self, tasks_path: Path) -> ImprovementTask | None:
        tasks = self._load_task_queue(tasks_path)
        for task in tasks:
            if task.get("status") == "pending":
                task["status"] = "in-progress"
                self._write_task_queue(tasks_path, tasks)
                return ImprovementTask(
                    id=task.get("id", ""),
                    title=task.get("title", ""),
                    status=task.get("status", "pending"),
                )
        return None

    def _set_task_status(self, tasks_path: Path, task_id: str, status: str) -> None:
        tasks = self._load_task_queue(tasks_path)
        for task in tasks:
            if task.get("id") == task_id:
                task["status"] = status
        self._write_task_queue(tasks_path, tasks)

    def fetch_documentation(self, url: str, docs_root: Path | None = None) -> Path:
        parsed = urlparse(url)
        host = parsed.netloc
        if not any(host == allowed or host.endswith(allowed.replace("*.", ".")) for allowed in config.NETWORK_ALLOWLIST):
            raise ValueError(f"Domain not allowlisted: {host}")

        with urlopen(url, timeout=config.COMMAND_TIMEOUT) as response:  # nosec - allowlisted validation above
            html = response.read().decode("utf-8", errors="replace")

        parser = _HTMLToTextParser()
        parser.feed(html)
        content = parser.as_markdown()

        root = docs_root or (config.WORKSPACE_ROOT / "docs")
        path_suffix = parsed.path.strip("/") or "index"
        target = root / host / f"{path_suffix}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return target

    def load_relevant_docs(self, task: str, docs_root: Path | None = None) -> str:
        root = docs_root or (config.WORKSPACE_ROOT / "docs")
        if not root.exists() or not any(keyword in task.lower() for keyword in ("api", "docs", "sdk", "http")):
            return ""
        snippets: list[str] = []
        for path in sorted(root.rglob("*.md")):
            snippets.append(f"## {path.relative_to(root)}\n{path.read_text()[:2000]}")
        return "\n\n".join(snippets)

    def update_agent_knowledge(self, task: str, result: str, success: bool, agent_md_path: Path | None = None) -> None:
        agent_md = agent_md_path or (config.WORKSPACE_ROOT / "AGENT.md")
        timestamp = datetime.now(timezone.utc).isoformat()
        status = "SUCCESS" if success else "FAILED"
        entry = (
            f"\n- {timestamp} [{status}]\n"
            f"  - Task: {task}\n"
            f"  - What changed: {result[:500] or 'No summary returned.'}\n"
        )
        with agent_md.open("a", encoding="utf-8") as f:
            f.write(entry)

    def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:
        queue_path = tasks_path or (config.WORKSPACE_ROOT / "tasks.json")
        summaries: list[str] = []

        while True:
            next_task = self.get_next_task(queue_path)
            if not next_task:
                break

            checkpoint_tag = f"checkpoint-{next_task.id}"
            self._emit_status(f"Creating checkpoint {checkpoint_tag}")
            git_checkpoint(checkpoint_tag)

            doc_context = self.load_relevant_docs(next_task.title)
            result = self.run_task(next_task.title, extra_context=doc_context)

            test_result = self.sandbox.execute("pytest tests/", timeout=config.COMMAND_TIMEOUT)
            if test_result.exit_code == 0:
                git_auto_commit(f"self-improve: {next_task.title}")
                self.update_agent_knowledge(next_task.title, result, success=True)
                self._set_task_status(queue_path, next_task.id, "completed")
                summaries.append(f"completed: {next_task.title}")
            else:
                git_revert_to_checkpoint(checkpoint_tag)
                self.update_agent_knowledge(next_task.title, test_result.stderr, success=False)
                self._set_task_status(queue_path, next_task.id, "pending")
                summaries.append(f"reverted: {next_task.title}")

        return summaries

    def _reset_conversation(self) -> None:
        self._base_messages = []


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the self-modifying agent")
    parser.add_argument("task", nargs="?", help="Task description to execute")
    parser.add_argument("--self-improve", action="store_true", help="Run the self-improvement task queue")
    args = parser.parse_args()

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

    if args.self_improve:
        result = {"summary": agent.run_self_improvement_cycle()}
    else:
        if not args.task:
            raise SystemExit("task is required unless --self-improve is provided")
        result = {"result": agent.run_task(args.task)}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
