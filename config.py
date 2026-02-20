"""Configuration and environment-driven overrides."""

from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional during bootstrap
    def load_dotenv() -> None:
        return None

load_dotenv()

AGENT_ENV = os.getenv("AGENT_ENV", "dev").lower()
if AGENT_ENV == "prod":
    WORKSPACE_ROOT = Path("/data")
else:
    WORKSPACE_ROOT = Path(os.getenv("WORKSPACE_ROOT", Path(__file__).resolve().parent))

MAX_STEPS = int(os.getenv("MAX_STEPS", "25"))
COMMAND_TIMEOUT = int(os.getenv("COMMAND_TIMEOUT", "30"))
MEMORY_LIMIT_MB = int(os.getenv("MEMORY_LIMIT_MB", "512"))
TOOL_RETRY_MAX = int(os.getenv("TOOL_RETRY_MAX", "2"))
TOOL_RETRY_BACKOFF_BASE = float(os.getenv("TOOL_RETRY_BACKOFF_BASE", "1.5"))
SELF_MODIFY_LIMIT_SESSION = int(os.getenv("SELF_MODIFY_LIMIT_SESSION", "3"))
SELF_MODIFY_LIMIT_DAY = int(os.getenv("SELF_MODIFY_LIMIT_DAY", "10"))
APPROVAL_TIMEOUT_MINUTES = int(os.getenv("APPROVAL_TIMEOUT_MINUTES", "30"))

DEFAULT_NETWORK_ALLOWLIST = [
    "api.anthropic.com",
    "*.pypi.org",
    "files.pythonhosted.org",
    "docs.anthropic.com",
]

CUSTOM_ALLOWLIST_PATH = WORKSPACE_ROOT / ".network_allowlist"


def load_network_allowlist() -> list[str]:
    if not CUSTOM_ALLOWLIST_PATH.exists():
        return list(DEFAULT_NETWORK_ALLOWLIST)

    custom_patterns = [
        line.strip()
        for line in CUSTOM_ALLOWLIST_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    return list(dict.fromkeys([*DEFAULT_NETWORK_ALLOWLIST, *custom_patterns]))


NETWORK_ALLOWLIST = load_network_allowlist()

CONSTITUTION_FILES = [
    "agent.py",
    "sandbox.py",
    "approval.py",
    "safety.py",
    "config.py",
    "slack_bot.py",
]

MODEL_ROUTING = {
    "routine": os.getenv("MODEL_ROUTINE", "claude-haiku-4-5"),
    "complex": os.getenv("MODEL_COMPLEX", "claude-sonnet-4-5"),
}

APPROVAL_AUDIT_LOG = WORKSPACE_ROOT / ".audit" / "approvals.jsonl"
TOOL_AUDIT_LOG = WORKSPACE_ROOT / ".audit" / "tool_actions.jsonl"
LLM_TELEMETRY_LOG = WORKSPACE_ROOT / ".audit" / "llm_usage.jsonl"
