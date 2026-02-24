import json
import subprocess
from pathlib import Path
from threading import Event
from unittest.mock import patch

from agent import Agent
from llm_client import LLMResponse, LLMUsage
from sandbox import ExecutionResult
from slack_bot import SlackBot


class MockLLM:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self.responses = responses

    def create_message(self, model: str, system: str, messages: list[dict], tools: list[dict] | None = None) -> LLMResponse:
        return self.responses.pop(0)


class AutoApprove:
    def request_approval(self, action_description: str, tier: str) -> bool:
        return True


class LocalSandbox:
    def __init__(self, cwd: Path) -> None:
        self.cwd = cwd

    def execute(self, command: str, timeout: int) -> ExecutionResult:
        result = subprocess.run(command, shell=True, cwd=self.cwd, text=True, capture_output=True, timeout=timeout)
        return ExecutionResult(stdout=result.stdout, stderr=result.stderr, exit_code=result.returncode)


class MemoryClient:
    def __init__(self) -> None:
        self.posts: list[dict[str, str]] = []

    def chat_postMessage(self, channel: str, text: str) -> dict[str, str]:
        self.posts.append({"channel": channel, "text": text})
        return {"ts": f"msg-{len(self.posts)}"}

    def reactions_add(self, channel: str, timestamp: str, name: str) -> None:  # noqa: ARG002
        return None


def _init_git_repo(repo: Path) -> None:
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "agent@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Agent"], cwd=repo, check=True)


def test_full_agent_loop_and_step_limit() -> None:
    llm = MockLLM(
        [
            LLMResponse(content=[{"type": "tool_use", "id": "1", "input": {"command": "echo hi"}}], stop_reason="tool_use", usage=LLMUsage(1, 1)),
            LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
        ]
    )

    class _Sandbox:
        def __init__(self) -> None:
            self.calls = 0

        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.calls += 1
            return ExecutionResult(stdout="ok", stderr="", exit_code=0)

    sandbox = _Sandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=AutoApprove())
    assert agent.run_task("run tool") == "done"
    assert sandbox.calls == 1


def test_git_safety_flow_commit_and_revert(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    target = tmp_path / "value.txt"
    target.write_text("good\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=tmp_path, check=True)

    with patch("safety.config.WORKSPACE_ROOT", tmp_path):
        from safety import git_auto_commit, git_checkpoint, git_revert_to_checkpoint

        target.write_text("better\n")
        git_auto_commit("improve")
        checkpoint = "checkpoint-test"
        git_checkpoint(checkpoint)
        target.write_text("broken\n")
        git_revert_to_checkpoint(checkpoint)

    assert target.read_text() == "better\n"


def test_self_improvement_cycle_marks_complete_updates_agent_and_commits(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "AGENT.md").write_text("# AGENT\n")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_smoke.py").write_text("def test_ok():\n    assert True\n")
    (tmp_path / "tasks.json").write_text(json.dumps([{"id": "t1", "title": "Update note", "status": "pending"}]))
    (tmp_path / "notes.md").write_text("start\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "bootstrap"], cwd=tmp_path, check=True)

    llm = MockLLM(
        [
            LLMResponse(
                content=[{"type": "tool_use", "id": "tool1", "input": {"command": "echo updated > notes.md"}}],
                stop_reason="tool_use",
                usage=LLMUsage(1, 1),
            ),
            LLMResponse(content=[{"type": "text", "text": "updated notes"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
        ]
    )
    agent = Agent(llm_client=llm, sandbox=LocalSandbox(tmp_path), approval_gate=AutoApprove())

    with patch("agent.config.WORKSPACE_ROOT", tmp_path), patch("safety.config.WORKSPACE_ROOT", tmp_path):
        summaries = agent.run_self_improvement_cycle(tasks_path=tmp_path / "tasks.json")

    assert summaries == ["completed: Update note"]
    assert '"status": "completed"' in (tmp_path / "tasks.json").read_text()
    assert "[SUCCESS]" in (tmp_path / "AGENT.md").read_text()
    log = subprocess.run(["git", "log", "--oneline", "-1"], cwd=tmp_path, check=True, capture_output=True, text=True).stdout
    assert "self-improve: Update note" in log


def test_rate_limit_and_constitution_enforcement() -> None:
    llm = MockLLM(
        [
            LLMResponse(content=[{"type": "tool_use", "id": "c1", "input": {"command": "echo x > config.py"}}], stop_reason="tool_use", usage=LLMUsage(1, 1)),
            LLMResponse(content=[{"type": "tool_use", "id": "c2", "input": {"command": "echo y > notes.md"}}], stop_reason="tool_use", usage=LLMUsage(1, 1)),
            LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
        ]
    )

    class _Limiter:
        def can_modify(self) -> bool:
            return False

        def record_modification(self) -> None:
            return None

    class _Sandbox:
        def __init__(self) -> None:
            self.calls = 0

        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.calls += 1
            return ExecutionResult(stdout="", stderr="", exit_code=0)

    sandbox = _Sandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=AutoApprove(), rate_limiter=_Limiter())
    result = agent.run_task("try edits")
    assert result == "done"
    assert sandbox.calls == 0


def test_slack_message_and_approval_flow() -> None:
    client = MemoryClient()
    done = Event()

    class _Agent:
        def __init__(self, gate, on_status):
            self.gate = gate
            self.on_status = on_status

        def run_task(self, text: str) -> str:
            self.on_status("Step 1/25: running")
            msg = self.gate.client.chat_postMessage(channel="C1", text="approval")
            self.gate.resolve_reaction(msg["ts"], "white_check_mark")
            done.set()
            return f"done: {text}"

    bot = SlackBot(client=client, agent_factory=lambda gate, on_status: _Agent(gate, on_status))
    bot.handle_message_event({"channel": "C1", "ts": "1", "text": "run check"})
    assert done.wait(timeout=2)
    assert any("Starting session" in p["text"] for p in client.posts)
    assert any("Session complete" in p["text"] for p in client.posts)
