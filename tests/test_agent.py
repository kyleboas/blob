from pathlib import Path
from unittest.mock import MagicMock, call, patch

from agent import Agent, _extract_urls, _parse_github_repo, _rewrite_github_auth_header
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


def test_system_prompt_enforces_pr_guardrails() -> None:
    agent = Agent(llm_client=MockLLM([]), sandbox=DummySandbox(), approval_gate=DummyApproval())

    prompt = agent._system_prompt
    assert "never use gh; it is not installed" in prompt
    assert "Never use fixed branch names like test-pr" in prompt
    assert "canary-pr-$RANDOM" in prompt
    assert "Never rely on git push origin" in prompt
    assert "Always create PRs via python github_tools.py create-pr" in prompt


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


def test_multiple_tool_uses_are_returned_in_one_tool_result_message() -> None:
    llm = MockLLM(
        [
            LLMResponse(
                content=[
                    {"type": "tool_use", "id": "tool1", "input": {"command": "echo one"}},
                    {"type": "tool_use", "id": "tool2", "input": {"command": "echo two"}},
                ],
                stop_reason="tool_use",
                usage=LLMUsage(1, 1),
            ),
            LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
        ]
    )
    sandbox = DummySandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    captured_messages: list[list[dict]] = []

    def capture(model: str, system: str, messages: list[dict], tools: list[dict] | None = None) -> LLMResponse:
        captured_messages.append([dict(item) for item in messages])
        return llm.responses.pop(0)

    llm.create_message = capture

    result = agent.run_task("run two commands")

    assert result == "ok"
    assert len(captured_messages) == 2
    second_call_messages = captured_messages[1]
    assert second_call_messages[-1]["role"] == "user"
    assert second_call_messages[-1]["content"] == [
        {"type": "tool_result", "tool_use_id": "tool1", "content": [{"type": "text", "text": "exit=0\nstdout:\nran\nstderr:\n"}]},
        {"type": "tool_result", "tool_use_id": "tool2", "content": [{"type": "text", "text": "exit=0\nstdout:\nran\nstderr:\n"}]},
    ]


def test_parse_github_repo() -> None:
    assert _parse_github_repo("git@github.com:octo/example.git") == "octo/example"
    assert _parse_github_repo("https://github.com/octo/example.git") == "octo/example"
    assert _parse_github_repo("https://gitlab.com/octo/example.git") is None


def test_rewrite_github_auth_header_uses_bearer_with_expandable_token() -> None:
    command = "curl -X POST -H 'Authorization: token $GITHUB_TOKEN' https://api.github.com/repos/o/r/pulls"
    rewritten = _rewrite_github_auth_header(command)
    assert rewritten == 'curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/o/r/pulls'


def test_agent_normalizes_bash_command_before_execution() -> None:
    llm = MockLLM([
        LLMResponse(
            content=[
                {
                    "type": "tool_use",
                    "id": "tool1",
                    "name": "bash",
                    "input": {
                        "command": "curl -H 'Authorization: token $GITHUB_TOKEN' https://api.github.com/repos/o/r/pulls"
                    },
                }
            ],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])
    sandbox = DummySandbox()
    agent = Agent(llm_client=llm, sandbox=sandbox, approval_gate=DummyApproval())

    result = agent.run_task("open pr")

    assert result == "ok"
    assert sandbox.commands[0] == 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/o/r/pulls'


def test_make_pr_tool_path() -> None:
    llm = MockLLM([
        LLMResponse(
            content=[
                {
                    "type": "tool_use",
                    "id": "tool1",
                    "name": "make_pr",
                    "input": {"title": "T", "body": "B", "repo": "octo/example", "head": "work", "base": "main"},
                }
            ],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])

    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    with patch.object(agent, "_create_github_pr", return_value="ok: opened PR") as mock_make_pr:
        result = agent.run_task("open pr")

    assert result == "ok"
    mock_make_pr.assert_called_once()




def test_push_branch_tool_path() -> None:
    llm = MockLLM([
        LLMResponse(
            content=[
                {
                    "type": "tool_use",
                    "id": "tool1",
                    "name": "push_branch",
                    "input": {"remote": "origin", "branch": "work"},
                }
            ],
            stop_reason="tool_use",
            usage=LLMUsage(1, 1),
        ),
        LLMResponse(content=[{"type": "text", "text": "ok"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
    ])

    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    with patch.object(agent, "_push_branch_to_remote", return_value="ok: pushed work to origin") as mock_push:
        result = agent.run_task("push fix")

    assert result == "ok"
    mock_push.assert_called_once()



def test_push_branch_uses_github_tools() -> None:
    agent = Agent(llm_client=MockLLM([]), sandbox=DummySandbox(), approval_gate=DummyApproval())

    def fake_run(cmd: list[str], **kwargs):
        if cmd[:4] == ["git", "remote", "get-url", "origin"]:
            return MagicMock(returncode=0, stdout="https://github.com/octo/example.git\n", stderr="")
        if cmd[:3] == ["python", "github_tools.py", "push"]:
            return MagicMock(returncode=0, stdout="ok", stderr="")
        raise AssertionError(f"unexpected command: {cmd}")

    with patch("agent.subprocess.run", side_effect=fake_run) as mock_run:
        result = agent._push_branch_to_remote({"remote": "origin", "branch": "feature-1"})

    assert result == "ok: pushed feature-1 to octo/example"
    push_call = mock_run.call_args_list[1][0][0]
    assert push_call == [
        "python",
        "github_tools.py",
        "push",
        "--owner",
        "octo",
        "--repo",
        "example",
        "--branch",
        "feature-1",
    ]


def test_create_pr_uses_github_tools_push_and_create_pr() -> None:
    agent = Agent(llm_client=MockLLM([]), sandbox=DummySandbox(), approval_gate=DummyApproval())

    def fake_run(cmd: list[str], **kwargs):
        if cmd[:4] == ["git", "remote", "get-url", "origin"]:
            return MagicMock(returncode=0, stdout="https://github.com/octo/example.git\n", stderr="")
        if cmd[:4] == ["git", "symbolic-ref", "refs/remotes/origin/HEAD"]:
            return MagicMock(returncode=0, stdout="refs/remotes/origin/main\n", stderr="")
        if cmd[:3] == ["python", "github_tools.py", "push"]:
            return MagicMock(returncode=0, stdout="pushed", stderr="")
        if cmd[:3] == ["python", "github_tools.py", "create-pr"]:
            return MagicMock(returncode=0, stdout='{"url": "https://example/pr/1", "number": 1}', stderr="")
        raise AssertionError(f"unexpected command: {cmd}")

    with patch("agent.subprocess.run", side_effect=fake_run) as mock_run, patch.dict("os.environ", {"GITHUB_TOKEN": "t"}):
        result = agent._create_github_pr({"title": "T", "body": "B", "head": "feature-1"})

    assert result == "ok: opened PR #1 https://example/pr/1"
    create_pr_call = mock_run.call_args_list[3][0][0]
    assert create_pr_call == [
        "python",
        "github_tools.py",
        "create-pr",
        "--owner",
        "octo",
        "--repo",
        "example",
        "--title",
        "T",
        "--body",
        "B",
        "--head",
        "octo:feature-1",
        "--base",
        "main",
    ]

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
        LLMResponse(content=[{"type": "text", "text": "did work"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
        LLMResponse(content=[{"type": "text", "text": "NONE"}], stop_reason="end_turn", usage=LLMUsage(1, 1)),
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


def test_reflect_on_task_returns_learning() -> None:
    llm = MockLLM([
        LLMResponse(
            content=[{"type": "text", "text": "- Always check git status before committing"}],
            stop_reason="end_turn",
            usage=LLMUsage(1, 1),
        )
    ])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    learning = agent._reflect_on_task("Refactor config loading", "Updated config.py to use absolute paths")
    assert learning == "- Always check git status before committing"


def test_reflect_on_task_returns_none_when_no_learning() -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "NONE"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    learning = agent._reflect_on_task("Say hi", "Greeted the user")
    assert learning is None


def test_reflect_on_task_returns_none_for_malformed_output() -> None:
    llm = MockLLM([
        LLMResponse(content=[{"type": "text", "text": "something without a dash prefix"}], stop_reason="end_turn", usage=LLMUsage(1, 1))
    ])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())
    learning = agent._reflect_on_task("task", "result")
    assert learning is None


def test_session_log_rotation(tmp_path: Path) -> None:
    """Session log is capped at 10 entries; oldest entries are dropped."""
    import re as _re

    agent_md = tmp_path / "AGENT.md"
    agent_md.write_text("# AGENT\n\n## Session Log\n")

    llm = MockLLM([])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())

    with patch("agent.config.WORKSPACE_ROOT", tmp_path):
        for i in range(12):
            agent.update_agent_knowledge(f"task-{i}", f"result-{i}", success=True)

    content = agent_md.read_text()
    log_section = content.split("## Session Log\n", 1)[1]
    entry_count = len(_re.findall(r"- \d{4}-", log_section))
    assert entry_count == 10
    assert "  - Task: task-0\n" not in content
    assert "  - Task: task-1\n" not in content
    assert "  - Task: task-11\n" in content


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


def test_get_authenticated_push_url_embeds_token(tmp_path: Path) -> None:
    llm = MockLLM([])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())

    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "https://github.com/kyleboas/blob.git\n"

    with patch("agent.subprocess.run", return_value=mock_result), \
         patch.dict("os.environ", {"GITHUB_TOKEN": "ghp_testtoken123"}):
        url = agent._get_authenticated_push_url("origin")

    assert url == "https://ghp_testtoken123@github.com/kyleboas/blob.git"


def test_get_authenticated_push_url_returns_none_without_token(tmp_path: Path) -> None:
    llm = MockLLM([])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())

    with patch.dict("os.environ", {}, clear=True):
        # Remove token env vars if present
        import os
        os.environ.pop("GITHUB_TOKEN", None)
        os.environ.pop("GH_TOKEN", None)
        url = agent._get_authenticated_push_url("origin")

    assert url is None


def test_get_authenticated_push_url_returns_none_on_git_failure(tmp_path: Path) -> None:
    llm = MockLLM([])
    agent = Agent(llm_client=llm, sandbox=DummySandbox(), approval_gate=DummyApproval())

    mock_result = MagicMock()
    mock_result.returncode = 128
    mock_result.stdout = ""

    with patch("agent.subprocess.run", return_value=mock_result), \
         patch.dict("os.environ", {"GITHUB_TOKEN": "ghp_testtoken123"}):
        url = agent._get_authenticated_push_url("origin")

    assert url is None
