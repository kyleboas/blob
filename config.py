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


def _load_blob_env() -> None:
    """Load credentials from .blob-env into os.environ if not already set.

    The Cloudflare sandbox environment writes credentials to /workspace/.blob-env
    using ``export KEY='VALUE'`` syntax.  This function parses that file and
    injects any missing variables into the current process so that GITHUB_TOKEN
    is available to git-askpass, github_tools, and all downstream code without
    requiring an explicit ``source`` call from each shell command.
    """
    import shlex

    candidates = [
        Path("/workspace/.blob-env"),
    ]
    for path in candidates:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            if "=" not in line:
                continue
            key, _, raw = line.partition("=")
            key = key.strip()
            if not key or not key.replace("_", "").isalnum():
                continue
            try:
                value = shlex.split(raw)[0]
            except (ValueError, IndexError):
                value = raw.strip("'\"")
            os.environ.setdefault(key, value)
        break


_load_blob_env()

# Load user preferences from blob_settings.json (written by `python blob_config.py set KEY VALUE`).
# Precedence: explicit env var > blob_settings.json > hardcoded default.
def _apply_user_settings() -> None:
    import json as _json
    _settings_path = Path(__file__).resolve().parent / "blob_settings.json"
    if not _settings_path.exists():
        return
    try:
        for k, v in _json.loads(_settings_path.read_text()).items():
            os.environ.setdefault(k, str(v))
    except Exception:
        pass

_apply_user_settings()

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
LLM_OVERLOAD_RETRY_MAX = int(os.getenv("LLM_OVERLOAD_RETRY_MAX", "4"))
LLM_OVERLOAD_RETRY_BASE_S = float(os.getenv("LLM_OVERLOAD_RETRY_BASE_S", "5.0"))
SELF_MODIFY_LIMIT_SESSION = int(os.getenv("SELF_MODIFY_LIMIT_SESSION", "3"))
SELF_MODIFY_LIMIT_DAY = int(os.getenv("SELF_MODIFY_LIMIT_DAY", "10"))
APPROVAL_TIMEOUT_MINUTES = int(os.getenv("APPROVAL_TIMEOUT_MINUTES", "30"))
AUTONOMOUS_MODE = os.getenv("AUTONOMOUS_MODE", "false").lower() == "true"
AUTONOMOUS_LOOP_INTERVAL = int(os.getenv("AUTONOMOUS_LOOP_INTERVAL", "60"))
AUTONOMOUS_DAILY_TASK_LIMIT = int(os.getenv("AUTONOMOUS_DAILY_TASK_LIMIT", "10"))

DEFAULT_NETWORK_ALLOWLIST = [
    "api.anthropic.com",
    "gateway.ai.cloudflare.com",
    "*.pypi.org",
    "files.pythonhosted.org",
    "docs.anthropic.com",
    "api.github.com",
    "github.com",
    "*.github.com",
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

CLOUDFLARE_AI_TO_MARKDOWN_URL = os.getenv("CLOUDFLARE_AI_TO_MARKDOWN_URL", "")
CLOUDFLARE_WORKERS_AI_MARKDOWN_CONVERSION_URL = os.getenv("CLOUDFLARE_WORKERS_AI_MARKDOWN_CONVERSION_URL", "")
CLOUDFLARE_MARKDOWN_FETCH_URL = os.getenv("CLOUDFLARE_MARKDOWN_FETCH_URL", "")
CLOUDFLARE_BROWSER_RENDER_MARKDOWN_URL = os.getenv("CLOUDFLARE_BROWSER_RENDER_MARKDOWN_URL", "")
CLOUDFLARE_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")

# Cloudflare AI Gateway – when CF_ACCOUNT_ID and CF_AI_GATEWAY_ID are both set,
# all LLM calls are routed through the gateway instead of calling the provider directly.
# The provider is derived automatically from the model name prefix
# (e.g. "openai/gpt-4.1-mini" → openai, "anthropic/claude-sonnet-4-6" → anthropic).
CLOUDFLARE_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CLOUDFLARE_AI_GATEWAY_ID = os.getenv("CF_AI_GATEWAY_ID", "")
# Deprecated: provider is now derived from the model name prefix.
CLOUDFLARE_AI_PROVIDER = os.getenv("CF_AI_PROVIDER", "anthropic")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_USERNAME = os.getenv("GITHUB_USERNAME", "")

CONSTITUTION_FILES = [
    "agent.py",
    "sandbox.py",
    "approval.py",
    "safety.py",
    "config.py",
    "slack_bot.py",
]

MODEL_ROUTING = {
    # Format: "provider/model-name". The provider prefix determines which API format
    # and endpoint to use. Supported: "openai/...", "anthropic/...".
    "routine": os.getenv("MODEL_ROUTINE", "openai/gpt-4.1-mini"),
    "complex": os.getenv("MODEL_COMPLEX", "anthropic/claude-sonnet-4-6"),
}

APPROVAL_AUDIT_LOG = WORKSPACE_ROOT / ".audit" / "approvals.jsonl"
TOOL_AUDIT_LOG = WORKSPACE_ROOT / ".audit" / "tool_actions.jsonl"
LLM_TELEMETRY_LOG = WORKSPACE_ROOT / ".audit" / "llm_usage.jsonl"
