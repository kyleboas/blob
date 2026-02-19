"""Approval gates and permission tier classification."""

from __future__ import annotations

import re
import threading
from typing import Protocol

import config
from safety import append_audit_log

READ_ONLY_PREFIXES = (
    "ls",
    "cat",
    "pwd",
    "echo",
    "find",
    "rg",
    "grep",
    "git log",
)


class ApprovalGate(Protocol):
    def request_approval(self, action_description: str, tier: str) -> bool:
        """Request approval for an action."""


def classify_action(command: str, target_files: list[str]) -> str:
    lowered = command.strip().lower()
    if any(path in config.CONSTITUTION_FILES for path in target_files):
        return "always-require-approval"
    has_write_op = bool(re.search(r"(>>|>|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bsed\s+-i)", lowered))
    if lowered.startswith(READ_ONLY_PREFIXES) and not has_write_op and not target_files:
        return "auto-approve"
    return "conditional"


class SlackApprovalGate:
    def __init__(self, client: object, channel: str, thread_ts: str, timeout_minutes: int = config.APPROVAL_TIMEOUT_MINUTES) -> None:
        self.client = client
        self.channel = channel
        self.thread_ts = thread_ts
        self.timeout_seconds = timeout_minutes * 60
        self._decisions: dict[str, bool] = {}
        self._events: dict[str, threading.Event] = {}

    def request_approval(self, action_description: str, tier: str) -> bool:
        if tier == "auto-approve":
            return True

        response = self.client.chat_postMessage(
            channel=self.channel,
            thread_ts=self.thread_ts,
            text=(
                f"Approval required ({tier}): {action_description}\n"
                "React with :white_check_mark: to approve or :x: to reject."
            ),
        )
        ts = response["ts"]
        append_audit_log(
            config.APPROVAL_AUDIT_LOG,
            {"message_ts": ts, "action": action_description, "tier": tier, "decision": "requested"},
        )

        self.client.reactions_add(channel=self.channel, timestamp=ts, name="white_check_mark")
        self.client.reactions_add(channel=self.channel, timestamp=ts, name="x")

        event = threading.Event()
        self._events[ts] = event
        approved = event.wait(timeout=self.timeout_seconds)
        if not approved:
            self._decisions[ts] = False
            append_audit_log(config.APPROVAL_AUDIT_LOG, {"message_ts": ts, "decision": "timeout_reject"})
        return self._decisions.get(ts, False)

    def resolve_reaction(self, message_ts: str, reaction: str) -> None:
        if message_ts not in self._events:
            return
        if reaction == "white_check_mark":
            self._decisions[message_ts] = True
            decision = "approved"
        elif reaction == "x":
            self._decisions[message_ts] = False
            decision = "rejected"
        else:
            return
        append_audit_log(
            config.APPROVAL_AUDIT_LOG,
            {"message_ts": message_ts, "reaction": reaction, "decision": decision},
        )
        self._events[message_ts].set()
