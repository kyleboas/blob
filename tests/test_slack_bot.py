from threading import Event

from approval import SlackApprovalGate
from slack_bot import SessionContext, SlackBot


class MockClient:
    def __init__(self) -> None:
        self.posts: list[dict[str, str]] = []

    def chat_postMessage(self, channel: str, text: str) -> dict[str, str]:
        self.posts.append({"channel": channel, "text": text})
        return {"ts": f"msg-{len(self.posts)}"}

    def reactions_add(self, channel: str, timestamp: str, name: str) -> None:  # noqa: ARG002
        return None


class StubAgent:
    def __init__(self, gate: SlackApprovalGate, on_status):
        self.gate = gate
        self.on_status = on_status

    def run_task(self, text: str) -> str:
        self.on_status("Step 1/25: running")
        return f"handled: {text}"

    def run_self_improvement_cycle(self) -> list[str]:
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
