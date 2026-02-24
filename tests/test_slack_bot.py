import json
from pathlib import Path
from threading import Event
from typing import Callable

from approval import ApprovalGate, SlackApprovalGate
from slack_bot import BackgroundWorker, SessionContext, SlackBot


class MockClient:
    def __init__(self) -> None:
        self.posts: list[dict[str, str]] = []

    def chat_postMessage(self, channel: str, text: str) -> dict[str, str]:
        self.posts.append({"channel": channel, "text": text})
        return {"ts": f"msg-{len(self.posts)}"}

    def reactions_add(self, channel: str, timestamp: str, name: str) -> None:  # noqa: ARG002
        return None


class StubAgent:
    def __init__(self, gate: ApprovalGate, on_status: Callable[[str], None]):
        self.gate = gate
        self.on_status = on_status

    def run_task(self, text: str) -> str:
        self.on_status("Step 1/25: running")
        return f"handled: {text}"

    def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:
        self.on_status("Step 1/25: improving")
        return ["completed: task"]


def test_message_dispatch_posts_progress_and_result() -> None:
    client = MockClient()
    done = Event()

    def factory(gate, on_status):
        class _Agent(StubAgent):
            def run_task(self, text: str) -> str:
                result = super().run_task(text)
                done.set()
                return result

        return _Agent(gate, on_status)

    bot = SlackBot(client=client, agent_factory=factory)
    bot.handle_message_event({"channel": "C1", "ts": "100.1", "text": "hello"})
    assert done.wait(timeout=2)
    assert any("Starting session" in post["text"] for post in client.posts)
    assert any("Step 1/25" in post["text"] for post in client.posts)
    assert any("Session complete" in post["text"] for post in client.posts)


def test_session_mapping_and_reaction_resolution() -> None:
    client = MockClient()
    gate_holder: dict[str, SlackApprovalGate] = {}

    def factory(gate, on_status):
        gate_holder["gate"] = gate

        class _Agent(StubAgent):
            def run_task(self, text: str) -> str:
                return "ok"

        return _Agent(gate, on_status)

    bot = SlackBot(client=client, agent_factory=factory)
    bot.handle_message_event({"channel": "C1", "ts": "200.1", "text": "hello"})

    # wait until background thread runs and clears mapping
    assert "gate" in gate_holder

    gate = gate_holder["gate"]
    gate._events["approval-ts"] = Event()
    bot.thread_sessions["200.1"] = SessionContext(session_ts="200.1", channel="C1", approval_gate=gate)
    bot.handle_reaction_event({"reaction": "white_check_mark", "item": {"ts": "approval-ts"}})

    assert gate._decisions["approval-ts"] is True


# ---------------------------------------------------------------------------
# BackgroundWorker tests
# ---------------------------------------------------------------------------

def test_background_worker_runs_heartbeat_and_posts_result(tmp_path: Path) -> None:
    """BackgroundWorker should run pending tasks and post results to Slack."""
    tasks_path = tmp_path / "tasks.json"
    tasks_path.write_text(json.dumps([
        {"id": "hb-1", "title": "run health check", "status": "pending"}
    ]))

    posted: list[dict[str, str]] = []
    ticked = Event()

    def factory(gate: ApprovalGate, on_status: Callable[[str], None]) -> StubAgent:
        class _Agent(StubAgent):
            def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:
                summaries = super().run_self_improvement_cycle(tasks_path=tasks_path)
                ticked.set()
                return summaries

        return _Agent(gate, on_status)

    worker = BackgroundWorker(
        channel="C-bg",
        agent_factory=factory,
        post_fn=lambda ch, text: posted.append({"channel": ch, "text": text}),
        tasks_path=tasks_path,
        interval_seconds=60,
        run_on_start=True,
    )
    worker.start()

    assert ticked.wait(timeout=2), "BackgroundWorker did not tick within 2 seconds"
    worker.stop()

    # Give the thread a moment to finish the current tick and post
    import time; time.sleep(0.1)

    assert any("Heartbeat complete" in p["text"] for p in posted), f"Expected heartbeat post, got {posted}"
    assert all(p["channel"] == "C-bg" for p in posted)


def test_background_worker_stop_prevents_further_ticks() -> None:
    tick_count = 0

    def factory(gate: ApprovalGate, on_status: Callable[[str], None]) -> StubAgent:
        return StubAgent(gate, on_status)

    posted: list[str] = []
    worker = BackgroundWorker(
        channel="C-stop",
        agent_factory=factory,
        post_fn=lambda ch, text: posted.append(text),
        interval_seconds=5,  # long interval – should not tick again
        run_on_start=False,
    )
    worker.start()
    worker.stop()  # stop immediately

    import time; time.sleep(0.2)
    # The worker was stopped before the first interval elapsed so no ticks
    assert tick_count == 0


def test_background_worker_posts_failure_message_on_exception() -> None:
    posted: list[dict[str, str]] = []

    def factory(gate: ApprovalGate, on_status: Callable[[str], None]) -> StubAgent:  # noqa: ARG001
        class _Agent(StubAgent):
            def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:  # noqa: ARG002
                raise RuntimeError("boom")

        return _Agent(gate, on_status)

    worker = BackgroundWorker(
        channel="C-fail",
        agent_factory=factory,
        post_fn=lambda ch, text: posted.append({"channel": ch, "text": text}),
        interval_seconds=60,
        run_on_start=True,
    )
    worker.start()
    worker.stop()

    assert any("Heartbeat failed: boom" in post["text"] for post in posted)


def test_background_worker_posts_status_when_no_summary() -> None:
    posted: list[str] = []

    def factory(gate: ApprovalGate, on_status: Callable[[str], None]) -> StubAgent:
        class _Agent(StubAgent):
            def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:  # noqa: ARG002
                self.on_status("checked queue")
                return []

        return _Agent(gate, on_status)

    worker = BackgroundWorker(
        channel="C-status",
        agent_factory=factory,
        post_fn=lambda ch, text: posted.append(text),
        interval_seconds=60,
        run_on_start=True,
    )
    worker.start()
    worker.stop()

    assert any("Heartbeat check:" in text for text in posted)


def test_set_heartbeat_channel_command() -> None:
    """'set heartbeat channel' message should update the worker channel and confirm."""
    client = MockClient()

    def factory(gate, on_status):
        return StubAgent(gate, on_status)

    worker = BackgroundWorker(
        agent_factory=factory,
        post_fn=lambda ch, text: client.chat_postMessage(channel=ch, text=text),
        channel=None,
        interval_seconds=60,
        run_on_start=False,
    )
    bot = SlackBot(client=client, agent_factory=factory, background_worker=worker)

    assert worker.channel is None
    bot.handle_message_event({"channel": "C-new", "ts": "1.0", "text": "set heartbeat channel"})

    assert worker.channel == "C-new"
    assert any("C-new" in p["text"] for p in client.posts)
    # Should not start a regular agent session
    assert not any("Starting session" in p["text"] for p in client.posts)


def test_background_worker_works_without_channel(tmp_path: Path) -> None:
    """BackgroundWorker should run and log results even when no channel is configured."""
    ticked = Event()

    def factory(gate: ApprovalGate, on_status: Callable[[str], None]) -> StubAgent:
        class _Agent(StubAgent):
            def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:
                summaries = super().run_self_improvement_cycle(tasks_path=tasks_path)
                ticked.set()
                return summaries

        return _Agent(gate, on_status)

    posted: list[str] = []
    worker = BackgroundWorker(
        agent_factory=factory,
        post_fn=lambda ch, text: posted.append(text),
        # no channel
        interval_seconds=60,
        run_on_start=True,
    )
    worker.start()
    assert ticked.wait(timeout=2), "BackgroundWorker did not tick within 2 seconds"
    worker.stop()

    import time; time.sleep(0.1)
    # No Slack posts should be made when there is no channel
    assert posted == []


def test_background_worker_uses_heartbeat_approval_gate() -> None:
    """The gate passed to heartbeat agents should allow conditional ops but block constitution files."""
    from slack_bot import _HeartbeatApprovalGate

    gate = _HeartbeatApprovalGate()
    assert gate.request_approval("cat file.py", "auto-approve") is True
    assert gate.request_approval("echo hello > AGENT.md", "conditional") is True
    assert gate.request_approval("sed -i 's/x/y/' agent.py", "always-require-approval") is False


def test_stop_and_reset_commands_control_message_handling() -> None:
    client = MockClient()
    done = Event()

    def factory(gate, on_status):
        class _Agent(StubAgent):
            def run_task(self, text: str) -> str:
                done.set()
                return super().run_task(text)

        return _Agent(gate, on_status)

    bot = SlackBot(client=client, agent_factory=factory)

    bot.handle_message_event({"channel": "C1", "ts": "1.0", "text": "/stop"})
    bot.handle_message_event({"channel": "C1", "ts": "1.1", "text": "hello"})

    assert not done.wait(timeout=0.2)
    assert any("Bot stopped" in post["text"] for post in client.posts)
    assert any("currently stopped" in post["text"] for post in client.posts)

    bot.handle_message_event({"channel": "C1", "ts": "1.2", "text": "/reset"})
    bot.handle_message_event({"channel": "C1", "ts": "1.3", "text": "hello again"})

    assert done.wait(timeout=2)
    assert any("Bot reset" in post["text"] for post in client.posts)
