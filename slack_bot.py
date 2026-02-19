"""Slack bot integration and thread-scoped session management."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Thread
from typing import Callable

import os

import config
from agent import Agent
from approval import SlackApprovalGate

try:
    from slack_bolt import App
    from slack_bolt.adapter.socket_mode import SocketModeHandler
except ImportError:  # pragma: no cover
    App = None
    SocketModeHandler = None


@dataclass(slots=True)
class SessionContext:
    thread_ts: str
    channel: str
    approval_gate: SlackApprovalGate


class SlackBot:
    def __init__(self, client: object, agent_factory: Callable[[SlackApprovalGate, Callable[[str], None]], Agent]) -> None:
        self.client = client
        self.agent_factory = agent_factory
        self.thread_sessions: dict[str, SessionContext] = {}

    def _post_status(self, channel: str, thread_ts: str, text: str) -> None:
        self.client.chat_postMessage(channel=channel, thread_ts=thread_ts, text=text)

    def handle_message_event(self, event: dict[str, str]) -> None:
        if event.get("subtype"):
            return

        text = event.get("text", "").strip()
        channel = event.get("channel", "")
        thread_ts = event.get("thread_ts") or event.get("ts", "")
        if not text or not channel or not thread_ts:
            return

        self._post_status(channel, thread_ts, "Starting session...")
        approval_gate = SlackApprovalGate(client=self.client, channel=channel, thread_ts=thread_ts)
        self.thread_sessions[thread_ts] = SessionContext(
            thread_ts=thread_ts,
            channel=channel,
            approval_gate=approval_gate,
        )

        def on_status(message: str) -> None:
            self._post_status(channel, thread_ts, message)

        def run() -> None:
            agent = self.agent_factory(approval_gate, on_status)
            try:
                if text.lower() == "self-improve":
                    result = "\n".join(agent.run_self_improvement_cycle())
                else:
                    result = agent.run_task(text)
                self._post_status(channel, thread_ts, f"Session complete:\n{result or '(no output)'}")
            except Exception as exc:  # pragma: no cover - defensive runtime reporting
                self._post_status(channel, thread_ts, f"Session failed: {exc}")
            finally:
                self.thread_sessions.pop(thread_ts, None)

        Thread(target=run, daemon=True).start()

    def handle_reaction_event(self, event: dict[str, dict[str, str] | str]) -> None:
        item = event.get("item", {})
        if not isinstance(item, dict):
            return
        ts = item.get("ts", "")
        reaction = event.get("reaction", "")
        for session in self.thread_sessions.values():
            session.approval_gate.resolve_reaction(message_ts=ts, reaction=str(reaction))


def _build_default_agent(approval_gate: SlackApprovalGate, on_status: Callable[[str], None]) -> Agent:
    from llm_client import AnthropicClient
    from sandbox import FlySpriteSandbox

    return Agent(
        llm_client=AnthropicClient(),
        sandbox=FlySpriteSandbox(),
        approval_gate=approval_gate,
        on_status=on_status,
    )


def main() -> None:
    if App is None or SocketModeHandler is None:
        raise RuntimeError("slack-bolt is required to run slack_bot.py")

    app = App(token=os.getenv("SLACK_BOT_TOKEN"))
    bot = SlackBot(client=app.client, agent_factory=_build_default_agent)

    @app.event("message")
    def on_message(event: dict[str, str], say: Callable[..., None]) -> None:  # noqa: ARG001
        bot.handle_message_event(event)

    @app.event("reaction_added")
    def on_reaction_added(event: dict[str, object]) -> None:
        bot.handle_reaction_event(event)

    handler = SocketModeHandler(app, os.getenv("SLACK_APP_TOKEN"))
    handler.start()


if __name__ == "__main__":
    main()
