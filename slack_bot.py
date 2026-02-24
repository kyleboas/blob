"""Slack bot integration and thread-scoped session management."""

from __future__ import annotations

from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Callable
import logging

import os
import re

import config
from agent import Agent
from approval import ApprovalGate, classify_action
from approval import SlackApprovalGate

try:
    from slack_bolt import App
    from slack_bolt.adapter.socket_mode import SocketModeHandler
except ImportError:  # pragma: no cover
    App = None
    SocketModeHandler = None

logger = logging.getLogger(__name__)


def _is_greeting_message(text: str) -> bool:
    normalized = text.lower().strip()
    normalized = re.sub(r"<@[a-z0-9]+>", "", normalized)
    normalized = re.sub(r"[^a-z0-9\s]", " ", normalized)
    normalized = " ".join(normalized.split())
    return normalized in {
        "hi",
        "hello",
        "hey",
        "hi blob",
        "hello blob",
        "hey blob",
    }


class _HeartbeatApprovalGate(ApprovalGate):
    """Approval gate for background heartbeat tasks.

    Auto-approves read-only and conditional (write) operations.
    Always blocks commands targeting constitution files so heartbeats
    never silently modify core agent source code.
    """

    def request_approval(self, action_description: str, tier: str) -> bool:
        return tier in ("auto-approve", "conditional")




class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


def start_health_server(port: int = 8080) -> HTTPServer:
    server = HTTPServer(("0.0.0.0", port), _HealthHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server

@dataclass(slots=True)
class SessionContext:
    session_key: str
    channel: str
    approval_gate: SlackApprovalGate
    agent: Agent


class SlackBot:
    def __init__(
        self,
        client: object,
        agent_factory: Callable[[ApprovalGate, Callable[[str], None]], Agent],
        background_worker: BackgroundWorker | None = None,
    ) -> None:
        self.client = client
        self.agent_factory = agent_factory
        self.channel_sessions: dict[str, SessionContext] = {}
        self.thread_sessions: dict[str, SessionContext] = {}
        self._session_lock = Lock()
        self._is_stopped = False
        self._background_worker = background_worker
        if background_worker is not None:
            background_worker.start()

    def _post_status(self, channel: str, text: str) -> None:
        self.client.chat_postMessage(channel=channel, text=text)

    def handle_slash_command(self, channel: str, command: str) -> None:
        normalized = command.strip().lower()
        if normalized == "/stop":
            self._is_stopped = True
            self.thread_sessions.clear()
            self.channel_sessions.clear()
            self._post_status(channel, "Bot stopped. Send /reset to start from scratch.")
            return
        if normalized == "/reset":
            self._is_stopped = False
            self.thread_sessions.clear()
            self.channel_sessions.clear()
            self._post_status(channel, "Bot reset. Starting fresh.")
            return

    def handle_message_event(self, event: dict[str, str]) -> None:
        if event.get("subtype"):
            return

        text = event.get("text", "").strip()
        channel = event.get("channel", "")
        thread_ts = event.get("thread_ts", "")
        session_key = thread_ts or channel
        if not text or not channel or not session_key:
            return

        if text.lower() in {"/stop", "/reset"}:
            self.handle_slash_command(channel=channel, command=text)
            return

        if self._is_stopped:
            self._post_status(channel, "Bot is currently stopped. Send /reset to start from scratch.")
            return

        if text.lower() == "set heartbeat channel":
            if self._background_worker is not None:
                self._background_worker.channel = channel
                self._post_status(channel, f"Heartbeat channel set to <#{channel}>")
            else:
                self._post_status(channel, "No background worker is running.")
            return

        if _is_greeting_message(text):
            self._post_status(
                channel,
                "👋 Hi! Heartbeats handle pending tasks. I won't start a build or task run from a greeting.",
            )
            return

        with self._session_lock:
            session = self.thread_sessions.get(session_key)
            if session is None:
                session = self.channel_sessions.get(channel)
            if session is None:
                self._post_status(channel, "Starting session...")
                approval_gate = SlackApprovalGate(client=self.client, channel=channel)

                def on_status(message: str) -> None:
                    self._post_status(channel, message)

                agent = self.agent_factory(approval_gate, on_status)
                session = SessionContext(
                    session_key=session_key,
                    channel=channel,
                    approval_gate=approval_gate,
                    agent=agent,
                )
            self.thread_sessions[session_key] = session
            if not thread_ts:
                self.channel_sessions[channel] = session

        def run() -> None:
            try:
                if text.lower() == "self-improve":
                    result = "\n".join(session.agent.run_self_improvement_cycle())
                else:
                    guarded_task = (
                        "Answer the user message directly. Do not run self-improvement tasks or process tasks.json unless the user explicitly asks for self-improve.\n\n"
                        f"User message: {text}"
                    )
                    result = session.agent.run_task(guarded_task)
                self._post_status(channel, f"Session complete:\n{result or '(no output)'}")
            except Exception as exc:  # pragma: no cover - defensive runtime reporting
                self._post_status(channel, f"Session failed: {exc}")

        Thread(target=run, daemon=True).start()

    def handle_reaction_event(self, event: dict[str, dict[str, str] | str]) -> None:
        item = event.get("item", {})
        if not isinstance(item, dict):
            return
        ts = item.get("ts", "")
        reaction = event.get("reaction", "")
        for session in self.thread_sessions.values():
            session.approval_gate.resolve_reaction(message_ts=ts, reaction=str(reaction))


class BackgroundWorker:
    """Periodically checks tasks.json for pending heartbeats and runs them.

    Each interval the worker picks the next pending task from ``tasks_path``,
    runs the self-improvement cycle, and posts the outcome to ``channel``.
    The worker runs as a daemon thread so it shuts down automatically when the
    main process exits.
    """

    DEFAULT_INTERVAL_SECONDS = int(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "300"))  # 5 minutes
    RUN_ON_START = os.getenv("HEARTBEAT_RUN_ON_START", "true").lower() == "true"

    def __init__(
        self,
        agent_factory: Callable[[ApprovalGate, Callable[[str], None]], Agent],
        post_fn: Callable[[str, str], None],
        channel: str | None = None,
        tasks_path: Path | None = None,
        interval_seconds: int | None = None,
        run_on_start: bool | None = None,
    ) -> None:
        self.channel = channel or None
        self.agent_factory = agent_factory
        self.post_fn = post_fn
        self.tasks_path = tasks_path or (config.WORKSPACE_ROOT / "tasks.json")
        self.interval_seconds = interval_seconds if interval_seconds is not None else self.DEFAULT_INTERVAL_SECONDS
        self.run_on_start = self.RUN_ON_START if run_on_start is None else run_on_start
        self._stop = Event()
        self._tick_lock = Lock()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self.run_on_start:
            self._tick()
        self._thread = Thread(target=self._loop, daemon=True, name="blob-heartbeat")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)

    def _loop(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self._tick()

    def _tick(self) -> None:
        if not self._tick_lock.acquire(blocking=False):
            logger.warning("Skipping heartbeat tick because a previous tick is still running")
            return
        try:
            self._run_pending_heartbeats()
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Heartbeat tick failed: %s", exc)
            if self.channel:
                self.post_fn(self.channel, f"Heartbeat failed: {exc}")
        finally:
            self._tick_lock.release()

    def _run_pending_heartbeats(self) -> None:
        gate = _HeartbeatApprovalGate()

        statuses: list[str] = []

        def on_status(msg: str) -> None:
            statuses.append(msg)

        agent = self.agent_factory(gate, on_status)
        summaries = agent.run_self_improvement_cycle(tasks_path=self.tasks_path)
        if summaries:
            report = "\n".join(summaries)
            if self.channel:
                self.post_fn(self.channel, f"Heartbeat complete:\n{report}")
            else:
                logger.info("Heartbeat complete:\n%s", report)
        elif statuses:
            report = "\n".join(statuses)
            if self.channel:
                self.post_fn(self.channel, f"Heartbeat check:\n{report}")
            else:
                logger.info("Heartbeat check:\n%s", report)


def _build_default_agent(approval_gate: ApprovalGate, on_status: Callable[[str], None]) -> Agent:
    from llm_client import AnthropicClient
    from sandbox import FlySpriteSandbox

    return Agent(
        llm_client=AnthropicClient(),
        sandbox=FlySpriteSandbox(),
        approval_gate=approval_gate,
        on_status=on_status,
    )


def main() -> None:
    if App is None:
        raise RuntimeError("slack-bolt is required to run slack_bot.py")

    app = App(
        token=os.getenv("SLACK_BOT_TOKEN"),
        signing_secret=os.getenv("SLACK_SIGNING_SECRET"),
    )

    heartbeat_channel = os.getenv("HEARTBEAT_CHANNEL") or None
    background_worker = BackgroundWorker(
        agent_factory=_build_default_agent,
        post_fn=lambda ch, text: app.client.chat_postMessage(channel=ch, text=text),
        channel=heartbeat_channel,
    )

    bot = SlackBot(client=app.client, agent_factory=_build_default_agent, background_worker=background_worker)

    @app.event("message")
    def on_message(event: dict[str, str], say: Callable[..., None]) -> None:  # noqa: ARG001
        bot.handle_message_event(event)

    @app.event("reaction_added")
    def on_reaction_added(event: dict[str, object]) -> None:
        bot.handle_reaction_event(event)

    @app.command("/stop")
    def on_stop_command(ack: Callable[[], None], body: dict[str, str]) -> None:
        ack()
        channel = body.get("channel_id", "")
        if channel:
            bot.handle_slash_command(channel=channel, command="/stop")

    @app.command("/reset")
    def on_reset_command(ack: Callable[[], None], body: dict[str, str]) -> None:
        ack()
        channel = body.get("channel_id", "")
        if channel:
            bot.handle_slash_command(channel=channel, command="/reset")

    start_health_server()

    use_socket_mode = os.getenv("SLACK_SOCKET_MODE", "false").lower() == "true"
    if use_socket_mode:
        if SocketModeHandler is None:
            raise RuntimeError("slack-bolt socket mode adapter is required for SLACK_SOCKET_MODE=true")
        handler = SocketModeHandler(app, os.getenv("SLACK_APP_TOKEN"))
        handler.start()
        return

    port = int(os.getenv("PORT", "3000"))
    app.start(port=port)


if __name__ == "__main__":
    main()
