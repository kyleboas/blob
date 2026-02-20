from pathlib import Path
from unittest.mock import MagicMock, call, patch

from agent import Agent
from llm_client import LLMResponse, LLMUsage
from sandbox import ExecutionResult


class DummyApproval:
    def __init__(self, allow: bool = True) -> None:
        self.allow = allow

    def request_approval(self, action_description: str, tier: str) -> bool:
        return self.allow


class DummySandbox:
    def __init__(self) -> None:
        self.called = 0
        self.commands: list[str] = []

    def execute(self, command: str, timeout: int) -> ExecutionResult:
        self.called += 1
        self.commands.append(command)
        if command == "pytest tests/":
            return ExecutionResult(stdout="ok", stderr="", exit_code=0)
        if command.startswith("curl -fsSL"):
            return ExecutionResult(stdout="<html><body><h1>Title</h1><p>Body</p></body></html>", stderr="", exit_code=0)
        return ExecutionResult(stdout="ran", stderr="", exit_code=0)


class MockLLM:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self.responses = responses

    def create_message(self, model: str, system: str, messages: list[dict], tools: list[dict] | None = None) -> LLMResponse:
        return self.responses.pop(0)


def test_loop_terminates_on_end_turn() -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    assert agent.run_task("say hi") == "done"


def test_tool_dispatch_and_on_status_callback() -> None:
    statuses: list[str] = []
    llm = MockLLM([
        LLMResponse(
            content=[{"type": "tool_use", "id": "tool1", "input": {"command": "echo hi"}}],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])
    sandbox = DummySandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval(), on_status=statuses.append)

    result = agent.run_task("run echo")
    assert result == "ok"
    assert sandbox.called == 1
    assert statuses


def test_step_limit_enforcement() -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "..."}], stop_reason="max_tokens", usage=LLMUsage(1, 1))
        for _ in range(3)
    ])
    sandbox = DummySandbox()
    with __import__("unittest").mock.patch("config.MAX_STEPS", 2):
        agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())
        assert agent.run_task("loop") == ""


def test_conversation_reset_behavior() -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
        LLMResponse(content=[{"type": "text", "text": "done2"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    agent.run_task("first")
    assert agent._base_messages == []
    assert agent.run_task("second") == "done2"


def test_task_queue_and_self_improve(tmp_path: Path) -> None:
    tasks_path = tmp_path / "tasks.json"
    tasks_path.write_text('[{"id": "1", "title": "Improve X", "status": "pending"}]')
    agent_md = tmp_path / "AGENT.md"
    agent_md.write_text("# AGENT\n\n## Session Log\n")

    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "did work"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = DummySandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch("agent.config.WORKSPACE_ROOT", tmp_path), patch("agent.git_checkpoint"), patch("agent.git_auto_commit"), patch(
        "agent.git_revert_to_checkpoint"
    ):
        summary = agent.run_self_improvement_cycle(tasks_path=tasks_path)

    assert summary == ["completed: Improve X"]
    assert '"status": "completed"' in tasks_path.read_text()
    assert "[SUCCESS]" in agent_md.read_text()


def test_tool_retry_on_transient_failure() -> None:
    """Failed tool calls are retried up to TOOL_RETRY_MAX times before reporting to LLM."""
    call_count = 0

    class FlakySandbox:
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                return ExecutionResult(stdout="", stderr="transient error", exit_code=1)
            return ExecutionResult(stdout="success", stderr="", exit_code=0)

    llm = MockLLM([
        LLMResponse(
            content=[{"type": "tool_use", "id": "tool1", "input": {"command": "echo hi"}}],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])

    with patch("config.TOOL_RETRY_MAX", 2), patch("time.sleep") as mock_sleep:
        agent = Agent(llm_client=llm, sandbox=FlakySandbox(), approval_gate=DummyApproval())
        result = agent.run_task("test retry")

    assert result == "ok"
    assert call_count == 3
    assert mock_sleep.call_count == 2


def test_tool_no_retry_after_max_attempts() -> None:
    """After TOOL_RETRY_MAX retries the final failure is reported to the LLM."""
    call_count = 0

    class AlwaysFailSandbox:
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            nonlocal call_count
            call_count += 1
            return ExecutionResult(stdout="", stderr="persistent error", exit_code=2)

    llm = MockLLM([
        LLMResponse(
            content=[{"type": "tool_use", "id": "tool1", "input": {"command": "bad-cmd"}}],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "gave up"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])

    with patch("config.TOOL_RETRY_MAX", 2), patch("time.sleep"):
        agent = Agent(llm_client=llm, sandbox=AlwaysFailSandbox(), approval_gate=DummyApproval())
        result = agent.run_task("test max retries")

    assert result == "gave up"
    assert call_count == 3  # 1 initial + 2 retries


def test_tool_no_retry_on_policy_rejection() -> None:
    """Sandbox policy rejections are deterministic and must not be retried."""
    call_count = 0

    class PolicyRejectSandbox:
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            nonlocal call_count
            call_count += 1
            return ExecutionResult(stdout="", stderr="Command rejected by sandbox policy", exit_code=1)

    llm = MockLLM([
        LLMResponse(
            content=[{"type": "tool_use", "id": "tool1", "input": {"command": "curl http://evil.com"}}],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])

    with patch("config.TOOL_RETRY_MAX", 2), patch("time.sleep"):
        agent = Agent(llm_client=llm, sandbox=PolicyRejectSandbox(), approval_gate=DummyApproval())
        result = agent.run_task("test policy rejection")

    assert result == "ok"
    assert call_count == 1  # No retry for policy rejections


def test_tool_retry_backoff_timing() -> None:
    """Exponential backoff sleeps use the correct wait times."""
    call_count = 0

    class AlwaysFailSandbox:
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            nonlocal call_count
            call_count += 1
            return ExecutionResult(stdout="", stderr="err", exit_code=1)

    llm = MockLLM([
        LLMResponse(
            content=[{"type": "tool_use", "id": "tool1", "input": {"command": "flaky"}}],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])

    with patch("config.TOOL_RETRY_MAX", 2), patch("config.TOOL_RETRY_BACKOFF_BASE", 2.0), patch("time.sleep") as mock_sleep:
        agent = Agent(llm_client=llm, sandbox=AlwaysFailSandbox(), approval_gate=DummyApproval())
        agent.run_task("test backoff")

    assert mock_sleep.call_args_list == [call(1.0), call(2.0)]


def test_fetch_documentation_allowlist_and_ingestion(tmp_path: Path) -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())

    output = agent.fetch_documentation("https://docs.anthropic.com/reference", docs_root=tmp_path)

    assert output.exists()
    assert "Title" in output.read_text()

    loaded = agent.load_relevant_docs("Read API docs", docs_root=tmp_path)
    assert "reference.md" in loaded
