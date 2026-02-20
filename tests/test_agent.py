from pathlib import Path
from unittest.mock import MagicMock, call, patch

from agent import Agent, _extract_urls
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



def test_fetch_documentation_auto_adds_domain_to_allowlist(tmp_path: Path) -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = DummySandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch("agent.config.WORKSPACE_ROOT", tmp_path), patch("agent.config.NETWORK_ALLOWLIST", ["docs.anthropic.com"]):
        output = agent.fetch_documentation("https://developers.cloudflare.com/workers", docs_root=tmp_path)

    assert output.exists()
    allowlist_file = tmp_path / ".network_allowlist"
    assert allowlist_file.exists()
    entries = allowlist_file.read_text().splitlines()
    assert "cloudflare.com" in entries
    assert "*.cloudflare.com" in entries

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


def test_run_task_auto_fetches_urls_and_updates_allowlist(tmp_path: Path) -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "summarized"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = DummySandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch("agent.config.WORKSPACE_ROOT", tmp_path), patch("agent.config.NETWORK_ALLOWLIST", ["docs.anthropic.com"]):
        result = agent.run_task("What can you learn from https://blog.cloudflare.com/code-mode-mcp/?x=1")

    assert result == "summarized"
    assert any(command.startswith("curl -fsSL") for command in sandbox.commands)
    allowlist_file = tmp_path / ".network_allowlist"
    assert "cloudflare.com" in allowlist_file.read_text().splitlines()






def test_fetch_documentation_prefers_single_cloudflare_markdown_service(tmp_path: Path) -> None:
    class WorkerSandbox(DummySandbox):
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.commands.append(command)
            if "/markdown-fetch" in command:
                return ExecutionResult(stdout='{"markdown":"# Edge Markdown"}', stderr="", exit_code=0)
            raise AssertionError("Expected single worker markdown endpoint to be used")

    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = WorkerSandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch("agent.config.CLOUDFLARE_MARKDOWN_FETCH_URL", "https://worker.example/markdown-fetch"), patch(
        "agent.config.CLOUDFLARE_API_TOKEN", "token"
    ):
        output = agent.fetch_documentation("https://example.com/docs", docs_root=tmp_path)

    assert output.read_text() == "# Edge Markdown"
    assert any("/markdown-fetch" in command for command in sandbox.commands)

def test_fetch_documentation_uses_user_agent_and_plain_text_fallback(tmp_path: Path) -> None:
    class PlainTextSandbox(DummySandbox):
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.commands.append(command)
            return ExecutionResult(stdout="plain text docs\n__BLOB_CONTENT_TYPE__:text/plain", stderr="", exit_code=0)

    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = PlainTextSandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    output = agent.fetch_documentation("https://example.com/docs", docs_root=tmp_path)

    assert output.read_text() == "plain text docs"
    assert any("BlobBot/1.0" in command for command in sandbox.commands)
    assert any("Accept: text/markdown" in command for command in sandbox.commands)





def test_fetch_documentation_prefers_workers_ai_markdown_conversion_endpoint_name(tmp_path: Path) -> None:
    class AISandbox(DummySandbox):
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.commands.append(command)
            if "/workers-ai/markdown-conversion" in command:
                return ExecutionResult(stdout='{"markdown":"# Workers AI Markdown"}', stderr="", exit_code=0)
            return ExecutionResult(
                stdout="<html><body><h1>Title</h1></body></html>\n__BLOB_CONTENT_TYPE__:text/html", stderr="", exit_code=0
            )

    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = AISandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch(
        "agent.config.CLOUDFLARE_WORKERS_AI_MARKDOWN_CONVERSION_URL",
        "https://api.cloudflare.com/client/v4/accounts/a/workers-ai/markdown-conversion",
    ), patch("agent.config.CLOUDFLARE_API_TOKEN", "token"):
        output = agent.fetch_documentation("https://example.com/docs", docs_root=tmp_path)

    assert output.read_text() == "# Workers AI Markdown"
    assert any("/workers-ai/markdown-conversion" in command for command in sandbox.commands)

def test_fetch_documentation_uses_cloudflare_ai_markdown_when_configured(tmp_path: Path) -> None:
    class AISandbox(DummySandbox):
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.commands.append(command)
            if "/ai/tomarkdown" in command:
                return ExecutionResult(stdout='{"markdown":"# Converted by AI"}', stderr="", exit_code=0)
            return ExecutionResult(
                stdout="<html><body><h1>Title</h1></body></html>\n__BLOB_CONTENT_TYPE__:text/html", stderr="", exit_code=0
            )

    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = AISandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch("agent.config.CLOUDFLARE_AI_TO_MARKDOWN_URL", "https://api.cloudflare.com/client/v4/accounts/a/ai/tomarkdown"), patch(
        "agent.config.CLOUDFLARE_API_TOKEN", "token"
    ):
        output = agent.fetch_documentation("https://example.com/docs", docs_root=tmp_path)

    assert output.read_text() == "# Converted by AI"
    assert any("/ai/tomarkdown" in command for command in sandbox.commands)


def test_fetch_documentation_uses_browser_rendering_markdown_when_configured(tmp_path: Path) -> None:
    class BrowserSandbox(DummySandbox):
        def execute(self, command: str, timeout: int) -> ExecutionResult:
            self.commands.append(command)
            if "/browser-rendering/markdown" in command:
                return ExecutionResult(stdout="# Rendered Page", stderr="", exit_code=0)
            return ExecutionResult(
                stdout="<html><body><script>hydrate()</script></body></html>\n__BLOB_CONTENT_TYPE__:text/html",
                stderr="",
                exit_code=0,
            )

    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "done"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    sandbox = BrowserSandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    with patch(
        "agent.config.CLOUDFLARE_BROWSER_RENDER_MARKDOWN_URL",
        "https://api.cloudflare.com/client/v4/accounts/a/browser-rendering/markdown",
    ), patch("agent.config.CLOUDFLARE_API_TOKEN", "token"):
        output = agent.fetch_documentation("https://example.com/docs", docs_root=tmp_path)

    assert output.read_text() == "# Rendered Page"
    assert any("/browser-rendering/markdown" in command for command in sandbox.commands)

def test_extract_urls_strips_trailing_punctuation_and_deduplicates() -> None:
    text = (
        "Learn from https://blog.cloudflare.com/code-mode-mcp/ and "
        "https://blog.cloudflare.com/code-mode-mcp/. Then compare with "
        "https://developers.cloudflare.com/workers), please."
    )

    assert _extract_urls(text) == [
        "https://blog.cloudflare.com/code-mode-mcp/",
        "https://developers.cloudflare.com/workers",
    ]


def test_extract_urls_handles_slack_link_format() -> None:
    text = (
        "So if I share <https://blog.cloudflare.com/code-mode-mcp/?utm_source=twitter|this post> "
        "in Slack, and also https://blog.cloudflare.com/code-mode-mcp/?utm_source=twitter>, what happens?"
    )

    assert _extract_urls(text) == ["https://blog.cloudflare.com/code-mode-mcp/?utm_source=twitter"]
