import time
from unittest.mock import Mock

from approval import SlackApprovalGate, classify_action


def test_classify_action_tiers() -> None:
    assert classify_action("ls -la", []) == "auto-approve"
    assert classify_action("echo hi > notes.md", ["notes.md"]) == "conditional"
    assert classify_action("echo x > safety.py", ["safety.py"]) == "always-require-approval"


def test_slack_approval_gate_reaction_approve() -> None:
    client = Mock()
    client.chat_postMessage.return_value = {"ts": "123.456"}
    gate = SlackApprovalGate(client=client, channel="C1", thread_ts="T1", timeout_minutes=1)

    from threading import Thread

    result_holder = {}

    def run() -> None:
        result_holder["value"] = gate.request_approval("edit file", "conditional")

    t = Thread(target=run)
    t.start()
    time.sleep(0.05)
    gate.resolve_reaction("123.456", "white_check_mark")
    t.join(timeout=1)

    assert result_holder["value"] is True


def test_slack_approval_gate_timeout_rejects() -> None:
    client = Mock()
    client.chat_postMessage.return_value = {"ts": "123.999"}
    gate = SlackApprovalGate(client=client, channel="C1", thread_ts="T1", timeout_minutes=0)
    assert gate.request_approval("danger", "always-require-approval") is False
