from dataclasses import dataclass

import config
from agent import Agent
from llm_client import LLMResponse, LLMUsage
from sandbox import ExecutionResult


class DummyApproval:
    def __init__(self, allow: bool = True) -> None:
        self.allow = allow

    def request_approval(self, action_description: str, tier: str) -> bool:
        return self.allow


@dataclass
class DummySandbox:
    called: int = 0

    def execute(self, command: str, timeout: int) -> ExecutionResult:
        self.called += 1
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
